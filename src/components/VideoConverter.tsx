import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import * as MP4Box from 'mp4box';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { VideoFormat, HTMLVideoElementWithCapture } from '../types';
import { FORMATS, WEBM_MIME_CANDIDATES, COPY_COMPATIBLE_FORMATS } from '../constants';

type DemuxedSample = {
  isSync: boolean;
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
};

type VideoTrack = {
  id: number;
  codec: string;
  width: number;
  height: number;
  timescale: number;
  description?: Uint8Array;
};

type EncodedChunkRecord = {
  data: Uint8Array;
  timestamp: number;
  duration?: number | undefined;
  type: EncodedVideoChunkType;
};

type WebCodecsRuntime = {
  VideoEncoderCtor: typeof VideoEncoder;
  VideoDecoderCtor: typeof VideoDecoder;
  EncodedVideoChunkCtor: typeof EncodedVideoChunk;
  mode: 'native';
};

async function getWebCodecsRuntime(args: {
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  preferredCodec?: 'vp8' | 'vp09.00.10.08';
}): Promise<WebCodecsRuntime> {
  const {
    width,
    height,
    framerate,
    bitrate,
    preferredCodec = 'vp8',
  } = args;

  const hasNative =
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined';

  if (!hasNative) {
    throw new Error('WebCodecs native nu este disponibil în acest browser.');
  }

  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: preferredCodec,
      width,
      height,
      framerate,
      bitrate,
      latencyMode: 'quality',
    });

    console.log('[WebCodecs native support check]', {
      codec: preferredCodec,
      supported: support.supported,
      width,
      height,
      framerate,
      bitrate,
    });

    if (!support.supported) {
      throw new Error(`WebCodecs encoder nu suportă codec-ul ${preferredCodec}.`);
    }

    return {
      VideoEncoderCtor: VideoEncoder,
      VideoDecoderCtor: VideoDecoder,
      EncodedVideoChunkCtor: EncodedVideoChunk,
      mode: 'native',
    };
  } catch (err) {
    console.warn('[WebCodecs native support check failed]', err);
    throw err instanceof Error
      ? err
      : new Error('WebCodecs native nu a putut fi inițializat.');
  }
}

async function getVideoMetadata(file: File): Promise<{
  durationSec: number;
  fps: number | null;
  frameCount: number | null;
}> {
  const url = URL.createObjectURL(file);

  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Nu am putut citi metadata video.'));
      };

      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
    });

    const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
    let fps: number | null = null;

    const maybeVideo = video as HTMLVideoElement & {
      getVideoPlaybackQuality?: () => {
        totalVideoFrames?: number;
      };
      webkitDecodedFrameCount?: number;
    };

    try {
      const startFrames =
        maybeVideo.getVideoPlaybackQuality?.().totalVideoFrames ??
        maybeVideo.webkitDecodedFrameCount ??
        0;

      await video.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      video.pause();

      const endFrames =
        maybeVideo.getVideoPlaybackQuality?.().totalVideoFrames ??
        maybeVideo.webkitDecodedFrameCount ??
        0;

      const measuredFrames = endFrames - startFrames;
      if (measuredFrames > 0) {
        fps = measuredFrames / 0.25;
      }
    } catch {}

    const frameCount =
      fps && durationSec > 0
        ? Math.round(fps * durationSec)
        : null;

    return { durationSec, fps, frameCount };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (mins === 0) return `${secs.toFixed(2)}s`;
  return `${mins}m ${secs.toFixed(2)}s`;
};

const formatMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return `${(ms / 1000).toFixed(2)}s`;
};

const getFileExtension = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext || 'mp4';
};

const pickSupportedWebmMimeType = (): string | null => {
  if (typeof MediaRecorder === 'undefined') return null;

  for (const mime of WEBM_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return null;
};

const buildFFmpegCommand = (
  inputName: string,
  outputName: string,
  outputType: VideoFormat
): string[] => {
  if (COPY_COMPATIBLE_FORMATS.includes(outputType)) {
    return ['-i', inputName, '-c', 'copy', outputName];
  }

  if (outputType === 'webm') {
    return [
      '-i',
      inputName,
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-row-mt',
      '1',
      '-threads',
      '4',
      '-c:a',
      'libvorbis',
      '-b:a',
      '128k',
      outputName,
    ];
  }

  return ['-i', inputName, outputName];
};

function normalizeMp4Codec(codec: string): string {
  return (codec || '').trim().toLowerCase();
}

function isAvcCodec(codec: string): boolean {
  const c = normalizeMp4Codec(codec);
  return c.startsWith('avc1') || c.startsWith('avc3');
}

function isVpCodec(codec: string): boolean {
  const c = normalizeMp4Codec(codec);
  return c.startsWith('vp08') || c.startsWith('vp8') || c.startsWith('vp09') || c.startsWith('vp9');
}

function isAv1Codec(codec: string): boolean {
  return normalizeMp4Codec(codec).startsWith('av01');
}
function isDecoderCompatibleMp4Codec(codec: string): boolean {
  return isAvcCodec(codec) || isVpCodec(codec) || isAv1Codec(codec);
}
function extractCodecDescriptionFromMp4Box(
  mp4boxFile: any,
  trackId: number
): Uint8Array | undefined {
  try {
    const trak = mp4boxFile.getTrackById?.(trackId);
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;

    if (!Array.isArray(entries) || entries.length === 0) {
      console.warn('[MP4 description] Nu am găsit stsd.entries pentru track', trackId);
      return undefined;
    }

    const DataStreamCtor =
      (MP4Box as any).DataStream ??
      (globalThis as any).DataStream;

    if (!DataStreamCtor) {
      console.warn('[MP4 description] DataStream nu este exportat de mp4box');
      return undefined;
    }

    for (const entry of entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;

      const stream = new DataStreamCtor(undefined, 0, DataStreamCtor.BIG_ENDIAN);
      box.write(stream);

      const fullBox = new Uint8Array(stream.buffer);
      if (fullBox.byteLength <= 8) {
        console.warn('[MP4 description] box serializat prea mic');
        return undefined;
      }

      // Sărim peste header-ul MP4 box: 4 bytes size + 4 bytes type
      return fullBox.slice(8);
    }

    console.warn('[MP4 description] Nu am găsit avcC/hvcC/vpcC/av1C în sample entry');
    return undefined;
  } catch (err) {
    console.warn('[MP4 description] extragerea a eșuat', err);
    return undefined;
  }
}

async function demuxMp4Video(file: File): Promise<{
  track: VideoTrack;
  samples: DemuxedSample[];
}> {
  type MP4BoxArrayBuffer = ArrayBuffer & { fileStart: number };

  const fileBuffer = await file.arrayBuffer();
  const mp4boxFile = MP4Box.createFile();

  const samples: DemuxedSample[] = [];
  let track: VideoTrack | null = null;
  let extractionStarted = false;

  const readyPromise = new Promise<void>((resolve, reject) => {
    mp4boxFile.onError = (e: unknown) => reject(e);

    mp4boxFile.onReady = (info: any) => {
      const videoTrack = info.videoTracks?.[0];
      if (!videoTrack) {
        reject(new Error('MP4-ul nu conține track video.'));
        return;
      }
      const description = extractCodecDescriptionFromMp4Box(mp4boxFile, videoTrack.id);
      track = {
        id: videoTrack.id,
        codec: normalizeMp4Codec(videoTrack.codec),
        width: videoTrack.video.width,
        height: videoTrack.video.height,
        timescale: videoTrack.timescale,
        description
      };

      mp4boxFile.setExtractionOptions(videoTrack.id, undefined, { nbSamples: 1 });
      mp4boxFile.start();
      extractionStarted = true;
      resolve();
    };

    mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: any[]) => {
      if (!track || trackId !== track.id) return;

      for (const s of mp4Samples) {
        samples.push({
          isSync: !!s.is_sync,
          timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
          durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
          data: new Uint8Array(s.data),
        });
      }
    };
  });

  const mp4boxBuffer = fileBuffer as MP4BoxArrayBuffer;
  mp4boxBuffer.fileStart = 0;
  mp4boxFile.appendBuffer(mp4boxBuffer);
  mp4boxFile.flush();

  await readyPromise;

  if (!track) {
    throw new Error('Nu am putut detecta track-ul video.');
  }

  if (!extractionStarted) {
    throw new Error('Extragerea sample-urilor MP4 nu a pornit.');
  }

  await new Promise((r) => setTimeout(r, 0));

  if (samples.length === 0) {
    throw new Error('Nu am extras sample-uri video din MP4.');
  }

  return { track, samples };
}

/**
 * În forma actuală, muxerul WebM nu e implementat.
 * Până nu îl legi, WebCodecs trebuie să stea pe fallback.
 */
async function muxWebMFromEncodedChunks(args: {
  chunks: EncodedChunkRecord[];
  width: number;
  height: number;
  codec: 'vp8' | 'vp09.00.10.08';
  framerate?: number;
}): Promise<Blob> {
  const { chunks, width, height, codec, framerate = 30 } = args;

  if (!chunks.length) {
    throw new Error('Nu există chunk-uri encodate pentru mux WebM.');
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: codec === 'vp8' ? 'V_VP8' : 'V_VP9',
      width,
      height,
      frameRate: framerate,
    },
    streaming: false,
    firstTimestampBehavior: 'offset',
  });

  for (const chunkRecord of chunks) {
    const chunk = new EncodedVideoChunk({
      type: chunkRecord.type,
      timestamp: chunkRecord.timestamp,
      duration: chunkRecord.duration,
      data: chunkRecord.data,
    });

    muxer.addVideoChunk(chunk);
  }

  muxer.finalize();

  const { buffer } = muxer.target;
  return new Blob([buffer], { type: 'video/webm' });
}

async function canUseWebCodecsForMp4ToWebm(file: File): Promise<boolean> {
  try {
    const { track, samples } = await demuxMp4Video(file);

    if (!samples.length) {
      console.warn('[WebCodecs gate] Nu există sample-uri');
      return false;
    }

    if (!samples[0].isSync) {
      console.warn('[WebCodecs gate] Primul sample nu este keyframe');
      return false;
    }

    if (!isDecoderCompatibleMp4Codec(track.codec)) {
      console.warn('[WebCodecs gate] Codec MP4 neacoperit pentru decoder path:', track.codec);
      return false;
    }

    if (isAvcCodec(track.codec) && !track.description?.byteLength) {
      console.warn('[WebCodecs gate] AVC/H.264 fără description extras din MP4 -> fallback');
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[WebCodecs gate] verificarea a eșuat -> fallback', err);
    return false;
  }
}

async function convertMp4ToWebmWithWebCodecs(args: {
  file: File;
  onProgress?: (progress01: number) => void;
  codec?: 'vp8' | 'vp09.00.10.08';
  bitrate?: number;
  framerate?: number;
}): Promise<{
  blob: Blob;
  width: number;
  height: number;
  frameCount: number;
  runtimeMode: 'native' | 'polyfill';
}> {
  const {
    file,
    onProgress,
    codec = 'vp8',
    bitrate = 1_800_000,
    framerate = 30,
  } = args;

  const { track, samples } = await demuxMp4Video(file);

  if (!samples.length) {
    throw new Error('Nu există sample-uri video.');
  }

  if (!samples[0].isSync) {
    throw new Error('Primul sample MP4 nu este keyframe. WebCodecs nu poate porni decoderul corect.');
  }

  const runtime = await getWebCodecsRuntime({
    width: track.width,
    height: track.height,
    framerate,
    bitrate,
    preferredCodec: codec,
  });

  console.log('[WebCodecs runtime]', {
    mode: runtime.mode,
    codec,
    sourceCodec: track.codec,
    width: track.width,
    height: track.height,
    framerate,
    bitrate,
  });

  const encodedChunks: EncodedChunkRecord[] = [];
  let decodedCount = 0;
  let encodedCount = 0;
  let decoderError: unknown = null;
  let encoderError: unknown = null;

  const encoder = new runtime.VideoEncoderCtor({
    output: (chunk: EncodedVideoChunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      chunk.copyTo(copy);

      encodedChunks.push({
        data: copy,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? undefined,
        type: chunk.type,
      });

      encodedCount += 1;
      onProgress?.(0.9 + Math.min(0.1, encodedCount / Math.max(1, samples.length)));
    },
    error: (e: DOMException) => {
      console.error('[WebCodecs encoder error]', e);
      encoderError = e;
    },
  });

  const decoder = new runtime.VideoDecoderCtor({
    output: (frame: VideoFrame) => {
      try {
        encoder.encode(frame, {
          keyFrame: decodedCount % 60 === 0,
        });
        decodedCount += 1;
        onProgress?.(Math.min(0.9, decodedCount / samples.length));
      } finally {
        frame.close();
      }
    },
    error: (e: DOMException) => {
      console.error('[WebCodecs decoder error]', e);
      decoderError = e;
    },
  });

  const decoderConfig: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
  };
  
  if (track.description?.byteLength) {
    decoderConfig.description = track.description;
  }
  
  decoder.configure(decoderConfig);

  encoder.configure({
    codec,
    width: track.width,
    height: track.height,
    bitrate,
    framerate,
    latencyMode: 'quality',
  });

  for (const sample of samples) {
    if (decoderError) throw decoderError;
    if (encoderError) throw encoderError;

    const chunk = new runtime.EncodedVideoChunkCtor({
      type: sample.isSync ? 'key' : 'delta',
      timestamp: sample.timestampUs,
      duration: sample.durationUs,
      data: sample.data,
    });

    decoder.decode(chunk);
  }

  await decoder.flush();
  if (decoderError) throw decoderError;

  await encoder.flush();
  if (encoderError) throw encoderError;

  decoder.close();
  encoder.close();

  onProgress?.(1);

  const blob = await muxWebMFromEncodedChunks({
  chunks: encodedChunks,
  width: track.width,
  height: track.height,
  codec,
  framerate,
});

  return {
    blob,
    width: track.width,
    height: track.height,
    frameCount: samples.length,
    runtimeMode: runtime.mode,
  };
}

export const VideoConverter: React.FC = () => {
  const [isLoadingEngine, setIsLoadingEngine] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const [inputType, setInputType] = useState<VideoFormat>('mp4');
  const [outputType, setOutputType] = useState<VideoFormat>('webm');

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [, setStatusText] = useState('Inițializare FFmpeg...');
  const [error, setError] = useState<string | null>(null);

  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);
  const [engineUsed, setEngineUsed] = useState<'ffmpeg' | 'mediarecorder' | 'webcodecs' | null>(null);

  const [conversionTimeMs, setConversionTimeMs] = useState<number | null>(null);
  const [sourceFrameCount, setSourceFrameCount] = useState<number | null>(null);
  const [sourceDurationSec, setSourceDurationSec] = useState<number | null>(null);
  const [sourceFps, setSourceFps] = useState<number | null>(null);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const inputPreviewUrlRef = useRef<string | null>(null);

  const videoFormats = useMemo(() => Object.keys(FORMATS) as VideoFormat[], []);
  const supportedWebmMimeType = useMemo(() => pickSupportedWebmMimeType(), []);

  const resetResult = useCallback(() => {
    setConversionTimeMs(null);
    setEngineUsed(null);

    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    setResultSize(null);
  }, []);

  const stopMediaRecorderResources = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {}
    }

    mediaRecorderRef.current = null;

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    mediaChunksRef.current = [];
  }, []);

  useEffect(() => {
    const initFFmpeg = async () => {
      try {
        const ffmpeg = new FFmpeg();

        ffmpeg.on('log', ({ message }) => {
          console.log('[FFmpeg]', message);
        });

        ffmpeg.on('progress', ({ progress: nextProgress }) => {
          const percent = Math.max(0, Math.min(100, Math.round(nextProgress * 100)));
          setProgress(percent);
          setStatusText(`Convertesc... ${percent}%`);
        });

        await ffmpeg.load();

        ffmpegRef.current = ffmpeg;
        setIsReady(true);
        setStatusText('FFmpeg este gata.');
      } catch (err) {
        console.error(err);
        setError('FFmpeg nu s-a putut încărca.');
        setStatusText('Eroare la inițializare.');
      } finally {
        setIsLoadingEngine(false);
      }
    };

    void initFFmpeg();

    return () => {
      resetResult();
      stopMediaRecorderResources();

      if (inputPreviewUrlRef.current) {
        URL.revokeObjectURL(inputPreviewUrlRef.current);
        inputPreviewUrlRef.current = null;
      }
    };
  }, [resetResult, stopMediaRecorderResources]);

  const handleInputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setInputType(nextType);
    setOutputType(nextType);
    setError(null);
    resetResult();
  }, [resetResult]);

  const handleOutputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setOutputType(nextType);
    setError(null);
    resetResult();
  }, [resetResult]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
    setProgress(0);
    resetResult();

    stopMediaRecorderResources();

    if (inputPreviewUrlRef.current) {
      URL.revokeObjectURL(inputPreviewUrlRef.current);
      inputPreviewUrlRef.current = null;
    }

    if (!file) {
      setSourceDurationSec(null);
      setSourceFps(null);
      setSourceFrameCount(null);
      return;
    }

    const ext = getFileExtension(file.name);
    const normalizedInputType = (videoFormats.includes(ext as VideoFormat) ? ext : 'mp4') as VideoFormat;
    setInputType(normalizedInputType);

    const previewUrl = URL.createObjectURL(file);
    inputPreviewUrlRef.current = previewUrl;

    void (async () => {
      try {
        const meta = await getVideoMetadata(file);

        setSourceDurationSec(meta.durationSec);
        setSourceFps(meta.fps);
        setSourceFrameCount(meta.frameCount);

        console.log('[Video metadata]', {
          fileName: file.name,
          sizeBytes: file.size,
          sizeHuman: formatBytes(file.size),
          durationSec: meta.durationSec,
          durationHuman: formatDuration(meta.durationSec),
          fpsEstimated: meta.fps,
          frameCountEstimated: meta.frameCount,
        });
      } catch (err) {
        console.warn('[Video metadata] indisponibilă:', err);
        setSourceDurationSec(null);
        setSourceFps(null);
        setSourceFrameCount(null);
      }
    })();
  }, [resetResult, stopMediaRecorderResources, videoFormats]);

  const clearAll = useCallback(() => {
    setSelectedFile(null);
    setError(null);
    setProgress(0);
    setStatusText(isReady ? 'Pregătit pentru conversie.' : 'Inițializare FFmpeg...');
    resetResult();
    stopMediaRecorderResources();

    if (inputPreviewUrlRef.current) {
      URL.revokeObjectURL(inputPreviewUrlRef.current);
      inputPreviewUrlRef.current = null;
    }

    if (previewVideoRef.current) {
      previewVideoRef.current.removeAttribute('src');
      previewVideoRef.current.load();
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    setSourceFrameCount(null);
    setSourceDurationSec(null);
    setSourceFps(null);
    setConversionTimeMs(null);
  }, [isReady, resetResult, stopMediaRecorderResources]);

  const convertWithWebCodecs = useCallback(async (): Promise<boolean> => {
    if (!selectedFile) return false;
    if (inputType !== 'mp4' || outputType !== 'webm') return false;

    setStatusText('Convertesc cu WebCodecs...');
    setProgress(0);

    const result = await convertMp4ToWebmWithWebCodecs({
      file: selectedFile,
      codec: 'vp8',
      bitrate: 1_800_000,
      framerate: sourceFps != null ? Math.max(1, Math.round(sourceFps)) : 30,
      onProgress: (p) => {
        const percent = Math.round(p * 100);
        setProgress(percent);
        setStatusText(`Convertesc cu WebCodecs... ${percent}%`);
      },
    });

    const url = URL.createObjectURL(result.blob);

    setResultUrl(url);
    setResultSize(result.blob.size);
    setEngineUsed('webcodecs');
    setProgress(100);
    setStatusText(
      result.runtimeMode === 'native'
        ? 'Conversie WebCodecs finalizată.'
        : 'Conversie WebCodecs polyfill finalizată.'
    );

    console.log('[Conversion output]', {
      engine: 'webcodecs',
      runtimeMode: result.runtimeMode,
      outputSizeBytes: result.blob.size,
      outputSizeHuman: formatBytes(result.blob.size),
      outputType: 'webm',
      width: result.width,
      height: result.height,
      frameCount: result.frameCount,
    });

    return true;
  }, [selectedFile, inputType, outputType, sourceFps]);

    const convertWithMediaRecorder = useCallback(async (): Promise<boolean> => {
    if (!selectedFile) return false;
    if (inputType !== 'mp4' || outputType !== 'webm') return false;
    if (!supportedWebmMimeType) return false;

    const video = previewVideoRef.current;
    if (!video) return false;

    const inputUrl = inputPreviewUrlRef.current;
    if (!inputUrl) return false;

    setStatusText('Pregătesc conversia rapidă...');
    setProgress(0);

    stopMediaRecorderResources();

    video.pause();
    video.currentTime = 0;
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.src = inputUrl;

    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Nu am putut încărca video-ul pentru conversia rapidă.'));
      };

      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onError);
      video.load();
    });

    const mediaVideo = video as HTMLVideoElementWithCapture;
    const captureStreamFn = mediaVideo.captureStream ?? mediaVideo.mozCaptureStream;

    if (!captureStreamFn) {
      throw new Error('captureStream() nu este disponibil în acest browser.');
    }

    const stream = captureStreamFn.call(video);
    mediaStreamRef.current = stream;
    mediaChunksRef.current = [];

    const recorder = new MediaRecorder(stream, {
      mimeType: supportedWebmMimeType,
      videoBitsPerSecond: 1_200_000,
    });

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        mediaChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      console.error('[MediaRecorder error]', event);
      setError('MediaRecorder a dat eroare în timpul conversiei rapide.');
      setStatusText('Eroare la conversia rapidă.');
    };

    const resultPromise = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const blob = new Blob(mediaChunksRef.current, { type: supportedWebmMimeType });

          if (blob.size === 0) {
            throw new Error('Rezultatul MediaRecorder este gol.');
          }

          const url = URL.createObjectURL(blob);

          setResultUrl(url);
          setResultSize(blob.size);
          setEngineUsed('mediarecorder');
          setProgress(100);
          setStatusText('Conversie rapidă finalizată.');

          console.log('[Conversion output]', {
            engine: 'mediarecorder',
            outputSizeBytes: blob.size,
            outputSizeHuman: formatBytes(blob.size),
            outputType: 'webm',
          });

          resolve();
        } catch (err) {
          reject(err);
        } finally {
          stopMediaRecorderResources();
        }
      };
    });

    const endedPromise = new Promise<void>((resolve, reject) => {
      const onEnded = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Video playback a eșuat în timpul conversiei rapide.'));
      };

      const cleanup = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
    });

    recorder.start(1000);
    setEngineUsed('mediarecorder');
    setStatusText('Convertesc rapid MP4 → WebM...');
    setProgress(15);

    try {
      await video.play();
    } catch (err) {
      console.error('[MediaRecorder play failed]', err);
      throw new Error('Browserul a blocat redarea video necesară pentru conversia rapidă.');
    }

    const progressInterval = window.setInterval(() => {
      if (!video.duration || !Number.isFinite(video.duration)) return;
      const percent = Math.max(0, Math.min(99, Math.round((video.currentTime / video.duration) * 100)));
      setProgress(percent);
    }, 150);

    try {
      await endedPromise;

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      await resultPromise;
      return true;
    } catch (err) {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {}
      }
      throw err;
    } finally {
      window.clearInterval(progressInterval);
      video.pause();
      video.currentTime = 0;
    }
  }, [
    inputType,
    outputType,
    selectedFile,
    stopMediaRecorderResources,
    supportedWebmMimeType,
  ]);

  const convertWithFFmpeg = useCallback(async () => {
    if (!selectedFile) {
      setError('Selectează un fișier video.');
      return;
    }

    if (!ffmpegRef.current || !isReady || isLoadingEngine) {
      setError('FFmpeg nu este gata încă.');
      return;
    }

    const ffmpeg = ffmpegRef.current;
    const inputExt = getFileExtension(selectedFile.name);
    const inputName = `input.${inputExt}`;
    const outputName = `output.${outputType}`;

    try {
      const fileData = await fetchFile(selectedFile);

      setEngineUsed('ffmpeg');
      setStatusText('Scriu fișierul în memorie...');
      await ffmpeg.writeFile(inputName, fileData);

      const command = buildFFmpegCommand(inputName, outputName, outputType);

      setStatusText('Pornesc conversia...');
      await ffmpeg.exec(command);

      setStatusText('Citesc rezultatul...');
      const outputData = await ffmpeg.readFile(outputName);

      if (typeof outputData === 'string') {
        throw new Error('Expected binary output from FFmpeg, but received text.');
      }

      const safeBytes = new Uint8Array(outputData.byteLength);
      safeBytes.set(outputData);

      const blob = new Blob([safeBytes], {
        type: FORMATS[outputType].mimeType,
      });

      const url = URL.createObjectURL(blob);

      setResultUrl(url);
      setResultSize(blob.size);
      setProgress(100);
      setStatusText('Conversie finalizată.');

      console.log('[Conversion output]', {
        engine: 'ffmpeg',
        outputSizeBytes: blob.size,
        outputSizeHuman: formatBytes(blob.size),
        outputType,
      });
    } finally {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {}

      try {
        await ffmpeg.deleteFile(outputName);
      } catch {}
    }
  }, [selectedFile, isReady, isLoadingEngine, outputType]);

  const convertFile = useCallback(async () => {
    if (!selectedFile) {
      setError('Selectează un fișier video.');
      return;
    }

    setIsConverting(true);
    setError(null);
    setProgress(0);
    setStatusText('Pregătesc fișierul...');
    resetResult();

    const startedAt = performance.now();

    console.log('[Conversion started]', {
      fileName: selectedFile.name,
      inputType,
      outputType,
      inputSizeBytes: selectedFile.size,
      inputSizeHuman: formatBytes(selectedFile.size),
      sourceDurationSec,
      sourceDurationHuman: sourceDurationSec !== null ? formatDuration(sourceDurationSec) : null,
      sourceFpsEstimated: sourceFps,
      sourceFrameCountEstimated: sourceFrameCount,
    });

    try {
      const shouldUseFastPath = inputType === 'mp4' && outputType === 'webm';

      if (shouldUseFastPath) {
        const canUseWebCodecs = await canUseWebCodecsForMp4ToWebm(selectedFile);

        if (canUseWebCodecs) {
          try {
            const wcWorked = await convertWithWebCodecs();
            if (wcWorked) {
              const elapsedMs = performance.now() - startedAt;
              setConversionTimeMs(elapsedMs);

              console.log('[Conversion finished]', {
                engine: 'webcodecs',
                elapsedMs,
                elapsedHuman: formatMs(elapsedMs),
              });

              return;
            }
          } catch (webCodecsError) {
            console.warn('[WebCodecs failed]', webCodecsError);
            setStatusText('WebCodecs a eșuat, încerc MediaRecorder...');
            setProgress(5);
          }
        } else {
          console.log('[WebCodecs skipped] fallback la MediaRecorder/FFmpeg');
          setStatusText('WebCodecs nu este potrivit pentru acest fișier, încerc MediaRecorder...');
          setProgress(5);
        }

        try {
          const fastWorked = await convertWithMediaRecorder();
          if (fastWorked) {
            const elapsedMs = performance.now() - startedAt;
            setConversionTimeMs(elapsedMs);

            console.log('[Conversion finished]', {
              engine: 'mediarecorder',
              elapsedMs,
              elapsedHuman: formatMs(elapsedMs),
            });

            return;
          }
        } catch (fastError) {
          console.warn('[MediaRecorder failed]', fastError);
          setStatusText('Conversia rapidă a eșuat, încerc cu FFmpeg...');
          setProgress(5);
        }
      }

      await convertWithFFmpeg();

      const elapsedMs = performance.now() - startedAt;
      setConversionTimeMs(elapsedMs);

      console.log('[Conversion finished]', {
        engine: 'ffmpeg',
        elapsedMs,
        elapsedHuman: formatMs(elapsedMs),
      });
    } catch (err) {
      console.error('[Conversion failed]', err);
      setError(
        err instanceof Error
          ? err.message
          : 'Conversia a eșuat.'
      );
      setStatusText('Eroare la conversie.');
    } finally {
      setIsConverting(false);
    }
  }, [
    selectedFile,
    inputType,
    outputType,
    resetResult,
    convertWithWebCodecs,
    convertWithMediaRecorder,
    convertWithFFmpeg,
    sourceDurationSec,
    sourceFps,
    sourceFrameCount,
  ]);

  const canConvert = !!selectedFile && !isConverting && (isReady || (inputType === 'mp4' && outputType === 'webm'));
  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 24,
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 16,
          padding: 20,
          boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
        }}
      >
        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Format input</label>
          <select
            value={inputType}
            onChange={handleInputTypeChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '1px solid #d1d5db',
              fontSize: 16,
            }}
          >
            {videoFormats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Format output</label>
          <select
            value={outputType}
            onChange={handleOutputTypeChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '1px solid #d1d5db',
              fontSize: 16,
            }}
          >
            {videoFormats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Fișier video</label>
          <input
            ref={fileInputRef}
            type="file"
            accept={FORMATS[inputType].accept}
            onChange={handleFileChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '2px dashed #60a5fa',
              background: '#f8fbff',
              fontSize: 15,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ display: 'none' }}>
          <video ref={previewVideoRef} preload="metadata" playsInline />
        </div>

        {selectedFile && (
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
            }}
          >
            <div><strong>Nume:</strong> {selectedFile.name}</div>
            <div><strong>Mărime:</strong> {formatBytes(selectedFile.size)}</div>
            <div><strong>Conversie:</strong> {inputType.toUpperCase()} → {outputType.toUpperCase()}</div>
            {engineUsed && (
              <div style={{ marginTop: 8 }}>
                <strong>Engine:</strong> {engineUsed}
              </div>
            )}
            {sourceDurationSec !== null && (
              <div><strong>Durată:</strong> {formatDuration(sourceDurationSec)}</div>
            )}
            {sourceFps !== null && (
              <div><strong>FPS estimat:</strong> {sourceFps.toFixed(2)}</div>
            )}
            {sourceFrameCount !== null && (
              <div><strong>Frame-uri estimate:</strong> {sourceFrameCount.toLocaleString()}</div>
            )}
            {conversionTimeMs !== null && (
              <div><strong>Timp ultimă conversie:</strong> {formatMs(conversionTimeMs)}</div>
            )}
          </div>
        )}

        <button
          onClick={convertFile}
          disabled={!canConvert}
          style={{
            width: '100%',
            padding: '15px 18px',
            borderRadius: 12,
            border: 'none',
            fontSize: 17,
            fontWeight: 700,
            color: '#fff',
            background: !canConvert ? '#9ca3af' : '#2563eb',
            cursor: !canConvert ? 'not-allowed' : 'pointer',
          }}
        >
          {isConverting
            ? `🔄 Convertesc... ${progress}%`
            : isLoadingEngine && !(inputType === 'mp4' && outputType === 'webm')
              ? '⏳ Încarc FFmpeg...'
              : '🚀 Convert video'}
        </button>

        <button
          onClick={clearAll}
          disabled={isConverting}
          style={{
            width: '100%',
            padding: '12px 18px',
            borderRadius: 12,
            border: '1px solid #d1d5db',
            fontSize: 15,
            fontWeight: 700,
            background: '#fff',
            cursor: isConverting ? 'not-allowed' : 'pointer',
          }}
        >
          Reset
        </button>

        <div
          style={{
            width: '100%',
            height: 16,
            background: '#e5e7eb',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #22c55e, #14b8a6)',
              transition: 'width 0.25s ease',
            }}
          />
        </div>

        {error && (
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              fontWeight: 600,
            }}
          >
            ❌ {error}
          </div>
        )}

        {resultUrl && (
          <div
            style={{
              padding: 20,
              background: '#ecfdf5',
              borderRadius: 16,
              border: '1px solid #a7f3d0',
            }}
          >
            <h3 style={{ marginTop: 0 }}>✅ Conversie gata</h3>

            {resultSize !== null && (
              <p style={{ marginTop: 0 }}>
                <strong>Mărime rezultat:</strong> {formatBytes(resultSize)}
              </p>
            )}

            <video
              controls
              style={{
                width: '100%',
                maxHeight: 420,
                borderRadius: 12,
                background: '#000',
              }}
            >
              <source src={resultUrl} type={FORMATS[outputType].mimeType} />
              Browserul tău nu suportă redarea acestui fișier.
            </video>

            <div style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a
                href={resultUrl}
                download={`converted-${Date.now()}.${outputType}`}
                style={{
                  display: 'inline-block',
                  padding: '12px 18px',
                  borderRadius: 10,
                  background: '#16a34a',
                  color: '#fff',
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                💾 Descarcă
              </a>

              <button
                onClick={clearAll}
                style={{
                  padding: '12px 18px',
                  borderRadius: 10,
                  background: '#475569',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                🔄 Conversie nouă
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};