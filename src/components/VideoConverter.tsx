import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import * as MP4Box from 'mp4box';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type {
  VideoFormat,
  HTMLVideoElementWithCapture,
  DemuxedAudioSample,
  AudioTrack,
  DemuxedSample,
  VideoTrack,
  WebCodecsRuntime,
  EncodedChunkRecord,
} from '../types';
import { FORMATS, WEBM_MIME_CANDIDATES, COPY_COMPATIBLE_FORMATS } from '../constants';


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

  // Încearcă prefer-hardware mai întâi, fallback la no-preference
  // Firefox nu suportă prefer-hardware pentru VP8
  let support = await VideoEncoder.isConfigSupported({
    codec: preferredCodec,
    width,
    height,
    framerate,
    bitrate,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  });

  if (!support.supported) {
    support = await VideoEncoder.isConfigSupported({
      codec: preferredCodec,
      width,
      height,
      framerate,
      bitrate,
      latencyMode: 'realtime',
      hardwareAcceleration: 'no-preference',
    });
  }

  console.log('[WebCodecs native support check]', {
    codec: preferredCodec,
    supported: support.supported,
    width,
    height,
    framerate,
    bitrate,
    config: support.config,
  });

  if (!support.supported) {
    throw new Error(`WebCodecs encoder nu suportă codec-ul ${preferredCodec}.`);
  }

  const confirmedHwAccel = support.config?.hardwareAcceleration ?? 'no-preference';

  return {
    VideoEncoderCtor: VideoEncoder,
    VideoDecoderCtor: VideoDecoder,
    EncodedVideoChunkCtor: EncodedVideoChunk,
    mode: 'native',
    hardwareAcceleration: confirmedHwAccel,
  };
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

function serializeMp4BoxPayload(box: any): Uint8Array | undefined {
  const DataStreamCtor =
    (MP4Box as any).DataStream ??
    (globalThis as any).DataStream;

  if (!DataStreamCtor || !box?.write) {
    return undefined;
  }

  const stream = new DataStreamCtor(undefined, 0, DataStreamCtor.BIG_ENDIAN);
  box.write(stream);

  const fullBox = new Uint8Array(stream.buffer);
  if (fullBox.byteLength <= 8) {
    return undefined;
  }

  return fullBox.slice(8);
}

function extractVideoCodecDescriptionFromMp4Box(
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

    for (const entry of entries) {
      const videoBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (videoBox) {
        const payload = serializeMp4BoxPayload(videoBox);
        if (payload?.byteLength) {
          return payload;
        }
      }
    }

    console.warn('[MP4 description] Nu am găsit config box video compatibil în sample entry');
    return undefined;
  } catch (err) {
    console.warn('[MP4 description] extragerea a eșuat', err);
    return undefined;
  }
}

function formatUint8Head(data?: Uint8Array, count = 16): number[] | null {
  if (!data?.byteLength) return null;
  return Array.from(data.slice(0, count));
}

// Dimensiunea unui chunk de fișier citit la un moment dat — 16MB
// Suficient pentru a menține pipeline-ul ocupat fără a exploda RAM-ul
const DEMUX_CHUNK_BYTES = 16 * 1024 * 1024;

// demuxMp4Streaming: citește fișierul în bucăți de DEMUX_CHUNK_BYTES
// și apelează onVideoSamples / onAudioSamples pe măsură ce vin sample-urile.
// Nu acumulează toate sample-urile în memorie — le consumă pe loc.
async function demuxMp4Streaming(
  file: File,
  callbacks: {
    onReady: (videoTrack: VideoTrack, audioTrack: AudioTrack | null) => void;
    onVideoSamples: (samples: DemuxedSample[]) => Promise<void>;
    onAudioSamples?: (samples: DemuxedAudioSample[]) => void;
    onError: (err: unknown) => void;
  }
): Promise<void> {
  type MP4BoxArrayBuffer = ArrayBuffer & { fileStart: number };

  const mp4boxFile = MP4Box.createFile();

  let videoTrack: VideoTrack | null = null;
  let audioTrack: AudioTrack | null = null;
  let readyResolveFn: (() => void) | null = null;
  let readyRejectFn: ((e: unknown) => void) | null = null;
  let processingError: unknown = null;

  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolveFn = resolve;
    readyRejectFn = reject;
  });

  mp4boxFile.onError = (e: unknown) => {
    processingError = e;
    callbacks.onError(e);
    readyRejectFn?.(e);
  };

  mp4boxFile.onReady = (info: any) => {
    const rawVideoTrack = info.videoTracks?.[0] ?? null;
    const rawAudioTrack = info.audioTracks?.[0] ?? null;

    if (!rawVideoTrack) {
      const err = new Error('MP4-ul nu conține track video.');
      processingError = err;
      callbacks.onError(err);
      readyRejectFn?.(err);
      return;
    }

    videoTrack = {
      id: rawVideoTrack.id,
      codec: normalizeMp4Codec(rawVideoTrack.codec),
      width: rawVideoTrack.video.width,
      height: rawVideoTrack.video.height,
      timescale: rawVideoTrack.timescale,
      description: extractVideoCodecDescriptionFromMp4Box(mp4boxFile, rawVideoTrack.id),
    };

    if (rawAudioTrack) {
      audioTrack = {
        id: rawAudioTrack.id,
        codec: normalizeMp4Codec(rawAudioTrack.codec),
        sampleRate: rawAudioTrack.audio.sample_rate,
        numberOfChannels: rawAudioTrack.audio.channel_count,
        timescale: rawAudioTrack.timescale,
        description: undefined,
      };
    }

    console.log('[MP4 demux ready]', {
      videoTrack: {
        id: videoTrack.id,
        codec: videoTrack.codec,
        width: videoTrack.width,
        height: videoTrack.height,
        timescale: videoTrack.timescale,
        descriptionLength: videoTrack.description?.byteLength ?? 0,
        descriptionHead: formatUint8Head(videoTrack.description),
      },
      audioTrack: audioTrack ? {
        id: audioTrack.id,
        codec: audioTrack.codec,
        sampleRate: audioTrack.sampleRate,
        numberOfChannels: audioTrack.numberOfChannels,
        timescale: audioTrack.timescale,
      } : null,
    });

    // Extragem sample-urile în batch-uri de 256 — suficient pentru pipeline
    // fără să acumulăm totul în memorie
    mp4boxFile.setExtractionOptions(rawVideoTrack.id, undefined, { nbSamples: 256 });
    if (rawAudioTrack) {
      mp4boxFile.setExtractionOptions(rawAudioTrack.id, undefined, { nbSamples: 256 });
    }

    callbacks.onReady(videoTrack, audioTrack);
    mp4boxFile.start();
    readyResolveFn?.();
  };

  // Serializam procesarea sample-urilor — onSamples poate fi apelat rapid
  // de mai multe ori și promise-urile ar putea rula în paralel, stricând ordinea
  let sampleChain: Promise<void> = Promise.resolve();

  mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: any[]) => {
    if (processingError) return;

    if (videoTrack && trackId === videoTrack.id) {
      // Copiem datele imediat — MP4Box poate refolosi bufferele
      const videoSamples: DemuxedSample[] = mp4Samples.map((s) => ({
        isSync: !!s.is_sync,
        timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
        durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
        data: new Uint8Array(s.data),
      }));

      mp4boxFile.releaseUsedSamples(trackId, mp4Samples[mp4Samples.length - 1].number);

      // Înlănțuim promise-urile — fiecare batch așteaptă batch-ul anterior
      // Garantează că onVideoSamples e apelat strict în ordine
      sampleChain = sampleChain.then(async () => {
        if (processingError) return;
        await callbacks.onVideoSamples(videoSamples);
      }).catch((err) => {
        processingError = err;
        callbacks.onError(err);
      });
    }

    if (audioTrack && trackId === audioTrack.id && callbacks.onAudioSamples) {
      const audioSamples: DemuxedAudioSample[] = mp4Samples.map((s) => ({
        timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
        durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
        data: new Uint8Array(s.data),
      }));

      mp4boxFile.releaseUsedSamples(trackId, mp4Samples[mp4Samples.length - 1].number);
      callbacks.onAudioSamples(audioSamples);
    }
  };

  // Trimitem fișierul chunk cu chunk
  // Primul chunk trebuie trimis ÎNAINTE de await readyPromise
  // altfel MP4Box nu primește niciodată date și onReady nu se apelează niciodată
  let offset = 0;

  while (offset < file.size) {
    if (processingError) throw processingError;

    const end = Math.min(offset + DEMUX_CHUNK_BYTES, file.size);
    const slice = file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer() as MP4BoxArrayBuffer;
    arrayBuffer.fileStart = offset;

    mp4boxFile.appendBuffer(arrayBuffer);
    offset = end;

    // Yield după fiecare chunk — lasă onReady și onSamples să fie apelate
    await yieldToEventLoop();
  }

  mp4boxFile.flush();

  // Așteptăm ready-ul (în cazul în care nu a venit încă)
  await readyPromise;

  // Așteptăm toate sample-urile să fie procesate în ordine
  await sampleChain;

  if (processingError) throw processingError;
}

// demuxMp4: versiune compatibilă cu codul existent — folosită doar pentru
// gate check (canUseWebCodecsForMp4ToWebm) unde avem nevoie de primele sample-uri
async function demuxMp4(file: File): Promise<{
  videoTrack: VideoTrack | null;
  audioTrack: AudioTrack | null;
  videoSamples: DemuxedSample[];
  audioSamples: DemuxedAudioSample[];
}> {
  type MP4BoxArrayBuffer = ArrayBuffer & { fileStart: number };

  // Pentru gate check citim doar primul chunk — suficient pentru metadata + primele sample-uri
  const firstChunk = file.slice(0, Math.min(DEMUX_CHUNK_BYTES, file.size));
  const fileBuffer = await firstChunk.arrayBuffer();
  const mp4boxFile = MP4Box.createFile();

  const videoSamples: DemuxedSample[] = [];
  const audioSamples: DemuxedAudioSample[] = [];

  let videoTrack: VideoTrack | null = null;
  let audioTrack: AudioTrack | null = null;

  const readyPromise = new Promise<void>((resolve, reject) => {
    mp4boxFile.onError = (e: unknown) => reject(e);

    mp4boxFile.onReady = (info: any) => {
      const rawVideoTrack = info.videoTracks?.[0] ?? null;
      const rawAudioTrack = info.audioTracks?.[0] ?? null;

      if (rawVideoTrack) {
        videoTrack = {
          id: rawVideoTrack.id,
          codec: normalizeMp4Codec(rawVideoTrack.codec),
          width: rawVideoTrack.video.width,
          height: rawVideoTrack.video.height,
          timescale: rawVideoTrack.timescale,
          description: extractVideoCodecDescriptionFromMp4Box(mp4boxFile, rawVideoTrack.id),
        };

        mp4boxFile.setExtractionOptions(rawVideoTrack.id, undefined, { nbSamples: 32 });
      }

      if (rawAudioTrack) {
        audioTrack = {
          id: rawAudioTrack.id,
          codec: normalizeMp4Codec(rawAudioTrack.codec),
          sampleRate: rawAudioTrack.audio.sample_rate,
          numberOfChannels: rawAudioTrack.audio.channel_count,
          timescale: rawAudioTrack.timescale,
          description: undefined,
        };

        mp4boxFile.setExtractionOptions(rawAudioTrack.id, undefined, { nbSamples: 32 });
      }

      if (!videoTrack) {
        reject(new Error('MP4-ul nu conține track video.'));
        return;
      }

      console.log('[MP4 demux ready]', {
        videoTrack: videoTrack ? {
          id: videoTrack.id,
          codec: videoTrack.codec,
          width: videoTrack.width,
          height: videoTrack.height,
          timescale: videoTrack.timescale,
          descriptionLength: videoTrack.description?.byteLength ?? 0,
          descriptionHead: formatUint8Head(videoTrack.description),
        } : null,
        audioTrack: audioTrack ? {
          id: audioTrack.id,
          codec: audioTrack.codec,
          sampleRate: audioTrack.sampleRate,
          numberOfChannels: audioTrack.numberOfChannels,
          timescale: audioTrack.timescale,
        } : null,
      });

      mp4boxFile.start();
      resolve();
    };

    mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: any[]) => {
      if (videoTrack && trackId === videoTrack.id) {
        for (const s of mp4Samples) {
          videoSamples.push({
            isSync: !!s.is_sync,
            timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
            durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
            data: new Uint8Array(s.data),
          });
        }
      }

      if (audioTrack && trackId === audioTrack.id) {
        for (const s of mp4Samples) {
          audioSamples.push({
            timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
            durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
            data: new Uint8Array(s.data),
          });
        }
      }
    };
  });

  const mp4boxBuffer = fileBuffer as MP4BoxArrayBuffer;
  mp4boxBuffer.fileStart = 0;
  mp4boxFile.appendBuffer(mp4boxBuffer);
  mp4boxFile.flush();

  await readyPromise;
  await new Promise((r) => setTimeout(r, 0));

  return { videoTrack, audioTrack, videoSamples, audioSamples };
}

async function muxWebMFromEncodedChunks(args: {
  videoChunks: EncodedChunkRecord[];
  width: number;
  height: number;
  codec: 'vp8' | 'vp09.00.10.08';
  framerate?: number;
  audioSamples?: DemuxedAudioSample[];
  audioTrack?: AudioTrack | null;
}): Promise<Blob> {
  const {
    videoChunks,
    width,
    height,
    codec,
    framerate = 30,
    audioSamples = [],
    audioTrack = null,
  } = args;

  if (!videoChunks.length) {
    throw new Error('Nu există chunk-uri video encodate pentru mux WebM.');
  }

  const hasAudio = audioSamples.length > 0 && audioTrack !== null;

  const muxerConfig: any = {
    target: new ArrayBufferTarget(),
    video: {
      codec: codec === 'vp8' ? 'V_VP8' : 'V_VP9',
      width,
      height,
      frameRate: framerate,
    },
    streaming: false,
    firstTimestampBehavior: 'offset',
  };

  if (hasAudio && audioTrack) {
    // Copy AAC direct — zero re-encodare, zero pierdere calitate
    muxerConfig.audio = {
      codec: 'A_AAC',
      sampleRate: audioTrack.sampleRate,
      numberOfChannels: audioTrack.numberOfChannels,
    };
  }

  const muxer = new Muxer(muxerConfig);

  for (const chunkRecord of videoChunks) {
    const chunk = new EncodedVideoChunk({
      type: chunkRecord.type,
      timestamp: chunkRecord.timestamp,
      duration: chunkRecord.duration,
      data: chunkRecord.data,
    });
    muxer.addVideoChunk(chunk);
  }

  if (hasAudio) {
    for (const sample of audioSamples) {
      const chunk = new EncodedAudioChunk({
        type: 'key', // AAC frames sunt toate key
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data: sample.data,
      });
      muxer.addAudioChunk(chunk);
    }
  }

  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  return new Blob([buffer], { type: 'video/webm' });
}

async function canUseWebCodecsForMp4ToWebm(file: File): Promise<boolean> {
  try {
    const { videoTrack, videoSamples } = await demuxMp4(file);

    if (!videoTrack) {
      console.warn('[WebCodecs gate] Nu există track video');
      return false;
    }

    if (!videoSamples.length) {
      console.warn('[WebCodecs gate] Nu există sample-uri video');
      return false;
    }

    if (!videoSamples[0].isSync) {
      console.warn('[WebCodecs gate] Primul sample video nu este keyframe');
      return false;
    }

    if (!isDecoderCompatibleMp4Codec(videoTrack.codec)) {
      console.warn('[WebCodecs gate] Codec video MP4 neacoperit pentru decoder path:', videoTrack.codec);
      return false;
    }

    if (isAvcCodec(videoTrack.codec) && !videoTrack.description?.byteLength) {
      console.warn('[WebCodecs gate] AVC/H.264 fără description extras din MP4 -> fallback');
      return false;
    }

    // Verificăm cu isConfigSupported dacă browserul poate decoda acest codec
    // Mai rapid decât un decode test real și nu are probleme de timeout
    const decoderCheck = await VideoDecoder.isConfigSupported({
      codec: videoTrack.codec,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      hardwareAcceleration: 'no-preference',
    });

    if (!decoderCheck.supported) {
      console.warn('[WebCodecs gate] VideoDecoder.isConfigSupported -> false pentru:', videoTrack.codec);
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[WebCodecs gate] verificarea a eșuat -> fallback', err);
    return false;
  }
}

// MessageChannel yield — mult mai rapid decât setTimeout(fn, 0/1)
// Cedează controlul browserului fără delay artificial
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
    port2.close();
  });
}

async function waitForEncoderBackpressure(
  encoder: VideoEncoder,
  maxQueueSize = 8
): Promise<void> {
  if (encoder.encodeQueueSize <= maxQueueSize) return;

  await new Promise<void>((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      encoder.removeEventListener('dequeue', onDequeue);
      clearTimeout(timeoutId);
      resolve();
    };

    const onDequeue = () => {
      if (encoder.encodeQueueSize <= maxQueueSize) finish();
    };

    // Timeout de siguranță redus la 4ms — doar fallback dacă dequeue nu trage
    const timeoutId = window.setTimeout(finish, 4);

    encoder.addEventListener('dequeue', onDequeue);

    if (encoder.encodeQueueSize <= maxQueueSize) finish();
  });
}

function getBrowserHints() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  return {
    isFirefox: /firefox/i.test(ua),
    isChrome:
      /chrome|chromium|crios/i.test(ua) &&
      !/edg|opr|opera/i.test(ua),
    isSafari:
      /^((?!chrome|android).)*safari/i.test(ua),
  };
}

function getTargetWebCodecsBitrate(args: {
  width: number;
  height: number;
  sourceBitrateKbps: number; // bitrate original al fișierului
}): number {
  const pixels = args.width * args.height;

  // Bitrate minim decent per rezoluție pentru VP8
  // VP8 e ~30% mai puțin eficient decât H.264 deci avem nevoie de un pic mai mult
  let minBitrate: number;
  if (pixels <= 640 * 360) {
    minBitrate = 800_000;
  } else if (pixels <= 1280 * 720) {
    minBitrate = 2_000_000;
  } else if (pixels <= 1920 * 1080) {
    minBitrate = 4_000_000;
  } else {
    // 4K
    minBitrate = 8_000_000;
  }

  // Bitrate maxim: sursă × 1.3 (VP8 are nevoie de ~30% mai mult decât H.264)
  // Nu are sens să depășim mult bitrate-ul sursei — fișierul devine mai mare
  // fără câștig real de calitate
  const sourceBasedMax = Math.round(args.sourceBitrateKbps * 1000 * 1.3);

  // Clampăm între minim decent și sursa × 1.3
  return Math.max(minBitrate, Math.min(sourceBasedMax, minBitrate * 3));
}

async function convertMp4ToWebmWithWebCodecs(args: {
  file: File;
  onProgress?: (progress01: number) => void;
  codec?: 'vp8' | 'vp09.00.10.08';
  bitrate?: number;
  framerate?: number;
  durationSec?: number;
}): Promise<{
  blob: Blob;
  hasAudio: boolean;
  width: number;
  height: number;
  frameCount: number;
  runtimeMode: 'native';
}> {
  const {
    file,
    onProgress,
    codec = 'vp8',
    bitrate = 1_200_000,
    framerate = 30,
    durationSec = 0,
  } = args;

  // ── Pasul 1: obținem metadata din demuxMp4Streaming — un singur demux ───────
  // NU mai apelăm demuxMp4 separat — asta era cauza "Decoding error":
  // fișierul era demuxat de 2 ori și decoder-ul primea sample-uri duplicate
  const demuxStartedAt = performance.now();

  // Citim doar primele 16MB pentru a obține metadata rapid
  // demuxMp4Streaming va citi tot fișierul în pasul 3
  let resolvedVideoTrack: VideoTrack | null = null;
  let resolvedAudioTrack: AudioTrack | null = null;

  {
    const { videoTrack: vt, audioTrack: at, videoSamples: vs } = await demuxMp4(file);
    if (!vt) throw new Error('Nu există track video.');
    if (!vs.length) throw new Error('Nu există sample-uri video.');
    if (!vs[0].isSync) throw new Error('Primul sample MP4 nu este keyframe.');
    resolvedVideoTrack = vt;
    resolvedAudioTrack = at;
  }

  const runtime = await getWebCodecsRuntime({
    width: resolvedVideoTrack.width,
    height: resolvedVideoTrack.height,
    framerate,
    bitrate,
    preferredCodec: codec,
  });

  // Estimăm bitrate-ul sursei din dimensiunea fișierului și durată
  // Scădem ~10% pentru overhead container + audio
  const estimatedSourceBitrateKbps = durationSec > 0
    ? Math.round((file.size * 8 * 0.9) / durationSec / 1000)
    : 8_000; // fallback 8Mbps dacă nu știm durata

  const tunedBitrate = getTargetWebCodecsBitrate({
    width: resolvedVideoTrack.width,
    height: resolvedVideoTrack.height,
    sourceBitrateKbps: estimatedSourceBitrateKbps,
  });

  console.log('[WebCodecs bitrate]', {
    fileSizeMB: (file.size / 1024 / 1024).toFixed(1),
    durationSec,
    estimatedSourceBitrateKbps,
    tunedBitrate,
  });

  const { isFirefox, isChrome } = getBrowserHints();
  const keyframeInterval = isFirefox ? 60 : isChrome ? 120 : 90;
  const firefoxMaxQueueSize = 32;
  const hwAccel = runtime.hardwareAcceleration;

  console.log('[WebCodecs runtime]', {
    mode: runtime.mode,
    codec,
    sourceVideoCodec: resolvedVideoTrack.codec,
    width: resolvedVideoTrack.width,
    height: resolvedVideoTrack.height,
    framerate,
    bitrateRequested: bitrate,
    bitrateUsed: tunedBitrate,
    browser: isFirefox ? 'firefox' : isChrome ? 'chrome' : 'other',
    keyframeInterval,
    hasAudio: !!resolvedAudioTrack,
  });

  // ── Pasul 2: setup encoder + decoder ──────────────────────────────────────
  const pipelineStartedAt = performance.now();

  const encodedVideoChunks: EncodedChunkRecord[] = [];
  let decodedVideoCount = 0;
  let encodedVideoCount = 0;
  let totalSampleCount = 0;
  let videoDecoderError: unknown = null;
  let videoEncoderError: unknown = null;

  const videoDecoderConfig: VideoDecoderConfig = {
    codec: resolvedVideoTrack.codec,
    codedWidth: resolvedVideoTrack.width,
    codedHeight: resolvedVideoTrack.height,
    hardwareAcceleration: hwAccel,
  };

  if (resolvedVideoTrack.description?.byteLength) {
    videoDecoderConfig.description = resolvedVideoTrack.description;
  }

  const decodedFramesQueue: VideoFrame[] = [];
  let demuxDone = false;

  // ── Encoder ────────────────────────────────────────────────────────────────
  const videoEncoder = new runtime.VideoEncoderCtor({
    output: (chunk: EncodedVideoChunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      chunk.copyTo(copy);
      encodedVideoChunks.push({
        data: copy,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? undefined,
        type: chunk.type,
      });
      encodedVideoCount += 1;
      if (totalSampleCount > 0) {
        onProgress?.(0.85 * Math.min(1, encodedVideoCount / totalSampleCount));
      }
    },
    error: (e: DOMException) => {
      console.error('[WebCodecs video encoder error]', e);
      videoEncoderError = e;
    },
  });

  videoEncoder.configure({
    codec,
    width: resolvedVideoTrack.width,
    height: resolvedVideoTrack.height,
    bitrate: tunedBitrate,
    framerate,
    latencyMode: 'realtime',
    hardwareAcceleration: hwAccel,
  });

  // ── Decoder ────────────────────────────────────────────────────────────────
  const videoDecoder = new runtime.VideoDecoderCtor({
    output: (frame: VideoFrame) => {
      if (isChrome) {
        try {
          if (videoEncoderError) { frame.close(); return; }
          const shouldForceKeyframe =
            decodedVideoCount === 0 || decodedVideoCount % keyframeInterval === 0;
          videoEncoder.encode(frame, { keyFrame: shouldForceKeyframe });
          decodedVideoCount += 1;
          if (totalSampleCount > 0) {
            onProgress?.(0.85 * Math.min(1, decodedVideoCount / totalSampleCount));
          }
        } finally {
          frame.close();
        }
      } else {
        decodedFramesQueue.push(frame);
      }
    },
    error: (e: DOMException) => {
      // Unele formate (ex: YUV444 pe Firefox) dau eroare pe frame-uri individuale
      // Dacă decoder-ul intră în stare closed, îl marcăm ca fatal
      console.warn('[WebCodecs video decoder error]', e.message);
      if (videoDecoder.state === 'closed') {
        videoDecoderError = e;
      }
    },
  });

  videoDecoder.configure(videoDecoderConfig);

  // ── Firefox pump — rulează în paralel cu demux-ul ─────────────────────────
  let pumpPromise: Promise<void> | null = null;

  if (!isChrome) {
    pumpPromise = (async () => {
      while (!demuxDone || decodedFramesQueue.length > 0) {
        if (videoDecoderError) throw videoDecoderError;
        if (videoEncoderError) throw videoEncoderError;

        if (decodedFramesQueue.length === 0) {
          await yieldToEventLoop();
          continue;
        }

        const batch = decodedFramesQueue.splice(0, decodedFramesQueue.length);
        for (const frame of batch) {
          if (videoDecoderError || videoEncoderError) {
            for (const f of batch) try { f.close(); } catch {}
            if (videoDecoderError) throw videoDecoderError;
            throw videoEncoderError;
          }
          try {
            await waitForEncoderBackpressure(videoEncoder, firefoxMaxQueueSize);
            const shouldForceKeyframe =
              decodedVideoCount === 0 || decodedVideoCount % keyframeInterval === 0;
            videoEncoder.encode(frame, { keyFrame: shouldForceKeyframe });
            decodedVideoCount += 1;
            if (totalSampleCount > 0) {
              onProgress?.(0.85 * Math.min(1, decodedVideoCount / totalSampleCount));
            }
          } finally {
            frame.close();
          }
        }
      }
    })();
  }

  // ── Pasul 3: streaming demux + decode în paralel ───────────────────────────
  // demuxMp4Streaming citește fișierul în chunks de 16MB și apelează
  // onVideoSamples pe măsură ce vine fiecare batch — nu acumulăm nimic în RAM
  let hasAudio = false;
  let resolvedAudioTrackForMux: AudioTrack | null = null;
  const collectedAudioSamples: DemuxedAudioSample[] = [];

  try {
  await demuxMp4Streaming(file, {
    onReady: (_vt, audioTrk) => {
      hasAudio = !!audioTrk;
      resolvedAudioTrackForMux = audioTrk;
    },
    onVideoSamples: async (samples) => {
      if (videoDecoderError) throw videoDecoderError;
      if (videoEncoderError) throw videoEncoderError;

      totalSampleCount += samples.length;

      // Trimitem sample-urile în mini-batch-uri de 32
      // și așteptăm backpressure între batch-uri ca să nu înecăm decoder-ul
      // STATUS_ACCESS_VIOLATION pe Chrome apare exact când decoder queue explodează
      const BATCH = 32;
      for (let i = 0; i < samples.length; i += BATCH) {
        if (videoDecoderError) throw videoDecoderError;
        if (videoEncoderError) throw videoEncoderError;

        const end = Math.min(i + BATCH, samples.length);
        for (let j = i; j < end; j++) {
          const sample = samples[j];
          const chunk = new runtime.EncodedVideoChunkCtor({
            type: sample.isSync ? 'key' : 'delta',
            timestamp: sample.timestampUs,
            duration: sample.durationUs,
            data: sample.data,
          });
          videoDecoder.decode(chunk);
        }

        // Așteptăm ca decoder queue să scadă sub limită înainte de batch-ul următor
        while (videoDecoder.decodeQueueSize > 16) {
          await yieldToEventLoop();
        }

        await yieldToEventLoop();
      }
    },
    onAudioSamples: (samples) => {
      // Colectăm audio samples din demux — copy AAC direct, zero re-encodare
      for (const s of samples) collectedAudioSamples.push(s);
    },
    onError: (err) => {
      videoDecoderError = err;
    },
  });
  } catch (demuxErr) {
    // Dacă demux pică, curățăm decoder/encoder înainte să aruncăm eroarea
    if (videoDecoder.state !== 'closed') try { videoDecoder.close(); } catch {}
    if (videoEncoder.state !== 'closed') try { videoEncoder.close(); } catch {}
    throw demuxErr;
  }

  const demuxEndedAt = performance.now();

  // ── Pasul 4: flush și așteptăm pipeline-ul să termine ────────────────────
  // Verificăm erorile ÎNAINTE de flush — dacă decoder/encoder sunt deja în eroare
  // sau closed, flush aruncă InvalidStateError
  if (videoDecoderError) throw videoDecoderError;
  if (videoEncoderError) throw videoEncoderError;

  if (videoDecoder.state !== 'closed') {
    await videoDecoder.flush();
  }

  demuxDone = true;

  if (pumpPromise) await pumpPromise;

  if (videoDecoderError) throw videoDecoderError;
  if (videoEncoderError) throw videoEncoderError;

  if (videoEncoder.state !== 'closed') {
    await videoEncoder.flush();
  }

  if (videoDecoderError) throw videoDecoderError;
  if (videoEncoderError) throw videoEncoderError;

  if (videoDecoder.state !== 'closed') videoDecoder.close();

  const pipelineEndedAt = performance.now();
  if (videoEncoder.state !== 'closed') videoEncoder.close();

  // ── Pasul 5: mux video + audio (AAC copy direct din demux) ─────────────────
  // Audio samples sunt deja colectate din demuxMp4Streaming — zero re-encodare
  encodedVideoChunks.sort((a, b) => a.timestamp - b.timestamp);

  const muxStartedAt = performance.now();

  const blob = await muxWebMFromEncodedChunks({
    videoChunks: encodedVideoChunks,
    width: resolvedVideoTrack!.width,
    height: resolvedVideoTrack!.height,
    codec,
    framerate,
    audioSamples: collectedAudioSamples,
    audioTrack: resolvedAudioTrackForMux,
  });
  const muxEndedAt = performance.now();

  onProgress?.(1);

  console.log('[WebCodecs timings]', {
    browser: isFirefox ? 'firefox' : isChrome ? 'chrome' : 'other',
    demuxMs: Math.round(demuxEndedAt - demuxStartedAt),
    pipelineMs: Math.round(pipelineEndedAt - pipelineStartedAt),
    muxMs: Math.round(muxEndedAt - muxStartedAt),
    decodedVideoFrames: decodedVideoCount,
    encodedVideoChunks: encodedVideoCount,
    totalSamples: totalSampleCount,
    audioSamples: collectedAudioSamples.length,
    finalSizeBytes: blob.size,
    finalSizeHuman: formatBytes(blob.size),
    hasAudioTrack: hasAudio,
  });

  return {
    blob,
    hasAudio: collectedAudioSamples.length > 0,
    width: resolvedVideoTrack!.width,
    height: resolvedVideoTrack!.height,
    frameCount: totalSampleCount,
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
  const audioContextRef = useRef<AudioContext | null>(null);

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

    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
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
          setProgress((prev) => {
            // Dacă suntem în faza audio mux (prev >= 85), mapăm progresul FFmpeg în 87–99%
            if (prev >= 85) return Math.max(prev, Math.round(87 + nextProgress * 12));
            // Conversie FFmpeg completă: folosim direct
            return percent;
          });
        });

        await ffmpeg.load();

        ffmpegRef.current = ffmpeg;
        setIsReady(true);
      } catch (err) {
        console.error(err);
        setError('FFmpeg nu s-a putut încărca.');
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
  }, [resetResult, stopMediaRecorderResources]);

  const convertWithWebCodecs = useCallback(async (): Promise<boolean> => {
    if (!selectedFile) return false;
    if (inputType !== 'mp4' || outputType !== 'webm') return false;

    setProgress(0);

    const wcResult = await convertMp4ToWebmWithWebCodecs({
      file: selectedFile,
      codec: 'vp8',
      framerate: sourceFps != null ? Math.max(1, Math.round(sourceFps)) : 30,
      durationSec: sourceDurationSec ?? 0,
      onProgress: (p) => {
        setProgress(Math.round(p * 100));
      },
    });

    // Audio e deja encodat și muxat în wcResult.blob via WebCodecs AudioEncoder
    // Nu mai avem nevoie de FFmpeg pentru audio
    const finalBlob = wcResult.blob;

    const url = URL.createObjectURL(finalBlob);
    setResultUrl(url);
    setResultSize(finalBlob.size);
    setEngineUsed('webcodecs');
    setProgress(100);

    console.log('[Conversion output]', {
      engine: 'webcodecs',
      audioMuxed: wcResult.hasAudio,
      runtimeMode: wcResult.runtimeMode,
      outputSizeBytes: finalBlob.size,
      outputSizeHuman: formatBytes(finalBlob.size),
      outputType: 'webm',
      width: wcResult.width,
      height: wcResult.height,
      frameCount: wcResult.frameCount,
    });

    return true;
  }, [selectedFile, inputType, outputType, sourceFps, isReady]);

  const convertWithMediaRecorder = useCallback(async (): Promise<boolean> => {
    if (!selectedFile) return false;
    if (inputType !== 'mp4' || outputType !== 'webm') return false;
    if (!supportedWebmMimeType) return false;

    const video = previewVideoRef.current;
    if (!video) return false;

    const inputUrl = inputPreviewUrlRef.current;
    if (!inputUrl) return false;

    setProgress(0);

    stopMediaRecorderResources();

    video.pause();
    video.currentTime = 0;
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
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

    const capturedStream = captureStreamFn.call(video) as MediaStream;
    const combinedStream = new MediaStream();

    for (const track of capturedStream.getVideoTracks()) {
      combinedStream.addTrack(track);
    }

    const AudioContextCtor =
      (window as any).AudioContext || (window as any).webkitAudioContext;

    if (!AudioContextCtor) {
      throw new Error('AudioContext nu este disponibil pentru fallback-ul MediaRecorder.');
    }

    const audioContext = new AudioContextCtor();
    audioContextRef.current = audioContext;

    const sourceNode = audioContext.createMediaElementSource(video);
    const destinationNode = audioContext.createMediaStreamDestination();

    sourceNode.connect(destinationNode);

    for (const track of destinationNode.stream.getAudioTracks()) {
      combinedStream.addTrack(track);
    }

    if (!combinedStream.getAudioTracks().length) {
      throw new Error('Nu am putut captura audio pentru MediaRecorder fallback.');
    }

    mediaStreamRef.current = combinedStream;
    mediaChunksRef.current = [];

    const recorder = new MediaRecorder(combinedStream, {
      mimeType: supportedWebmMimeType,
      videoBitsPerSecond: 1_200_000,
      audioBitsPerSecond: 128_000,
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
    setProgress(15);

    try {
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
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
      await ffmpeg.writeFile(inputName, fileData);

      const command = buildFFmpegCommand(inputName, outputName, outputType);
      await ffmpeg.exec(command);

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
        let webCodecsGatePassed = false;

        try {
          const canUseWebCodecs = await canUseWebCodecsForMp4ToWebm(selectedFile);
          webCodecsGatePassed = canUseWebCodecs;

          if (canUseWebCodecs) {
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
          }
        } catch (webCodecsError) {
          console.warn('[WebCodecs skipped/failed]', webCodecsError);
          setProgress(5);
        }

        // Sărim MediaRecorder dacă gate check-ul a eșuat (ex: YUV444, format nesuportat)
        // În acest caz browserul nu poate reda fișierul nici în <video> — MediaRecorder
        // ar rămâne blocat la 15% fără eroare
        if (webCodecsGatePassed) {
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
            setProgress(5);
          }
        } else {
          console.log('[Orchestrator] Gate check eșuat -> sar MediaRecorder -> direct FFmpeg');
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
    <div className="card">
      <div style={{ display: 'none' }}>
        <video ref={previewVideoRef} preload="metadata" playsInline />
      </div>

      <div className="status-row">
        <div className={`status-dot ${isReady ? 'status-dot--ready' : 'status-dot--loading'}`} />
        <span className="status-text">
          {isReady ? 'FFmpeg ready' : isLoadingEngine ? 'Loading FFmpeg…' : 'FFmpeg unavailable'}
        </span>
        {engineUsed && !isConverting && (
          <span className="engine-badge">
            {engineUsed === 'webcodecs' ? '⚡ WebCodecs' : engineUsed === 'mediarecorder' ? 'MediaRecorder' : 'FFmpeg'}
          </span>
        )}
      </div>

      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType} onChange={handleInputTypeChange}
            disabled={isLoadingEngine || isConverting}>
            {videoFormats.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </div>
        <div className="format-arrow">→</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType} onChange={handleOutputTypeChange}
            disabled={isLoadingEngine || isConverting}>
            {videoFormats.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">File</label>
        <input
          ref={fileInputRef}
          type="file"
          className="file-input"
          accept={FORMATS[inputType].accept}
          onChange={handleFileChange}
          disabled={isLoadingEngine || isConverting}
        />
      </div>

      {selectedFile && !isConverting && !resultUrl && (
        <div className="file-info">
          <span>{selectedFile.name}</span>
          <span className="file-info-sep">·</span>
          <span>{formatBytes(selectedFile.size)}</span>
          {sourceDurationSec !== null && <>
            <span className="file-info-sep">·</span>
            <span>{formatDuration(sourceDurationSec)}</span>
          </>}
          {sourceFps !== null && <>
            <span className="file-info-sep">·</span>
            <span>{sourceFps.toFixed(0)} fps</span>
          </>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button className="btn-primary" onClick={convertFile} disabled={!canConvert}>
          {isConverting
            ? `Converting… ${progress}%`
            : isLoadingEngine && !(inputType === 'mp4' && outputType === 'webm')
              ? 'Loading FFmpeg…'
              : 'Convert'}
        </button>
        <button className="btn-ghost" onClick={clearAll} disabled={isConverting}>
          Reset
        </button>
      </div>

      {(isConverting || progress > 0) && (
        <div className="progress-wrap">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <div className="badge badge--error">{error}</div>}

      {resultUrl && (
        <div className="result-section">
          <div className="badge badge--success">
            Done{resultSize !== null ? ` — ${formatBytes(resultSize)}` : ''}{conversionTimeMs !== null ? ` · ${formatMs(conversionTimeMs)}` : ''}
          </div>
          <video controls className="result-video">
            <source src={resultUrl} type={FORMATS[outputType].mimeType} />
          </video>
          <div className="btn-row">
            <a href={resultUrl} download={`converted-${Date.now()}.${outputType}`}
              className="btn-download-link">
              Download
            </a>
            <button onClick={clearAll} className="btn-ghost">Convert another</button>
          </div>
        </div>
      )}
    </div>
  );
};