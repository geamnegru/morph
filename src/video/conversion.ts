import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import * as MP4Box from 'mp4box';
import type {
  VideoFormat,
  DemuxedAudioSample,
  AudioTrack,
  DemuxedSample,
  VideoTrack,
  WebCodecsRuntime,
  EncodedChunkRecord,
  Mp4BoxFile,
  Mp4DataStreamCtor,
  Mp4WritableBox,
  Mp4Sample,
  Mp4FileInfo,
} from '../types';
import { COPY_COMPATIBLE_FORMATS } from '../constants';
import { formatBytes } from '../utils/fileUtils';



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

export async function getVideoMetadata(file: File): Promise<{
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
    } catch {
      // Metadata probing is best-effort only.
    }

    const frameCount =
      fps && durationSec > 0
        ? Math.round(fps * durationSec)
        : null;

    return { durationSec, fps, frameCount };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadVideoForPlayback(file: File): Promise<{
  video: HTMLVideoElement;
  cleanup: () => void;
}> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');

  video.preload = 'auto';
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Browserul nu poate reda acest fișier video pentru pipeline-ul WebCodecs.'));
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });

  return {
    video,
    cleanup: () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

void loadVideoForPlayback;

export const buildFFmpegCommand = (
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

function serializeMp4BoxPayload(box: Mp4WritableBox | undefined): Uint8Array | undefined {
  const DataStreamCtor =
    ((MP4Box as unknown as { DataStream?: Mp4DataStreamCtor }).DataStream) ??
    ((globalThis as unknown as { DataStream?: Mp4DataStreamCtor }).DataStream);

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
  mp4boxFile: Mp4BoxFile,
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

  const mp4boxFile = MP4Box.createFile() as unknown as Mp4BoxFile;

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

  mp4boxFile.onReady = (info: Mp4FileInfo) => {
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

  mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: Mp4Sample[]) => {
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
  const mp4boxFile = MP4Box.createFile() as unknown as Mp4BoxFile;

  const videoSamples: DemuxedSample[] = [];
  const audioSamples: DemuxedAudioSample[] = [];

  let videoTrack: VideoTrack | null = null;
  let audioTrack: AudioTrack | null = null;

  const readyPromise = new Promise<void>((resolve, reject) => {
    mp4boxFile.onError = (e: unknown) => reject(e);

    mp4boxFile.onReady = (info: Mp4FileInfo) => {
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

    mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: Mp4Sample[]) => {
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

  const muxerConfig: {
    target: ArrayBufferTarget;
    video: {
      codec: 'V_VP8' | 'V_VP9';
      width: number;
      height: number;
      frameRate: number;
    };
    streaming: false;
    firstTimestampBehavior: 'offset';
    audio?: {
      codec: 'A_AAC';
      sampleRate: number;
      numberOfChannels: number;
    };
  } = {
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

  // Cap absolut per rezoluție — dincolo de asta VP8 nu câștigă calitate
  let cap: number;
  if (pixels <= 640 * 360)       cap = 1_500_000;
  else if (pixels <= 1280 * 720) cap = 4_000_000;
  else if (pixels <= 1920 * 1080) cap = 8_000_000;
  else                            cap = 12_000_000; // 4K VP8 max decent

  // Bitrate țintă: sursă × 0.8 (VP8 e mai puțin eficient dar nu are sens să depășim sursa)
  const sourceBasedTarget = Math.round(args.sourceBitrateKbps * 1000 * 0.8);

  return Math.max(minBitrate, Math.min(sourceBasedTarget, cap));
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
            for (const f of batch) {
              try { f.close(); } catch { /* ignore cleanup errors */ }
            }
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
    if (videoDecoder.state !== 'closed') try { videoDecoder.close(); } catch { /* ignore cleanup errors */ }
    if (videoEncoder.state !== 'closed') try { videoEncoder.close(); } catch { /* ignore cleanup errors */ }
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

async function convertVideoToWebmWithBrowserPlayback(args: {
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
    framerate = 30,
    durationSec = 0,
  } = args;

  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Output,
    WebMOutputFormat,
    getFirstEncodableAudioCodec,
    getFirstEncodableVideoCodec,
  } = await import('mediabunny');

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();

    if (!videoTrack) {
      throw new Error('Nu există track video pentru conversia WebM.');
    }

    const width = videoTrack.displayWidth;
    const height = videoTrack.displayHeight;

    if (!width || !height) {
      throw new Error('Nu am putut determina dimensiunile video pentru conversia WebCodecs.');
    }

    const estimatedSourceBitrateKbps = durationSec > 0
      ? Math.round((file.size * 8 * 0.9) / durationSec / 1000)
      : 8_000;

    const tunedBitrate = getTargetWebCodecsBitrate({
      width,
      height,
      sourceBitrateKbps: estimatedSourceBitrateKbps,
    });

    const requestedVideoCodec = codec === 'vp09.00.10.08' ? 'vp9' : 'vp8';

    const videoCodec = await getFirstEncodableVideoCodec([requestedVideoCodec], {
      width,
      height,
      bitrate: tunedBitrate,
    });

    if (!videoCodec) {
      throw new Error(`Browserul nu poate encoda ${codec.toUpperCase()} pentru pipeline-ul WebM.`);
    }

    const audioCodec = audioTrack
      ? await getFirstEncodableAudioCodec(['opus', 'vorbis'], {
          numberOfChannels: audioTrack.numberOfChannels,
          sampleRate: audioTrack.sampleRate,
          bitrate: 128_000,
        })
      : null;

    const target = new BufferTarget();
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    });

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: videoCodec,
        bitrate: tunedBitrate,
        frameRate: framerate,
        forceTranscode: true,
        keyFrameInterval: 4,
        hardwareAcceleration: 'no-preference',
      },
      audio: audioCodec
        ? {
            codec: audioCodec,
            bitrate: 128_000,
            forceTranscode: true,
          }
        : {
            discard: true,
          },
      showWarnings: false,
    });

    if (!conversion.isValid) {
      throw new Error('Conversia WebM nu este validă pentru fișierul selectat în pipeline-ul WebCodecs.');
    }

    conversion.onProgress = (progress) => {
      onProgress?.(Math.max(0, Math.min(1, progress)));
    };

    await conversion.execute();

    const buffer = target.buffer;
    if (!buffer) {
      throw new Error('Outputul WebM generat este gol.');
    }

    const blob = new Blob([buffer], { type: 'video/webm' });
    const estimatedFrameCount =
      durationSec > 0
        ? Math.max(1, Math.round(durationSec * framerate))
        : 0;

    onProgress?.(1);

    console.log('[Mediabunny WebM conversion]', {
      inputName: file.name,
      width,
      height,
      videoCodec,
      audioCodec,
      fileSizeBytes: file.size,
      outputSizeBytes: blob.size,
    });

    return {
      blob,
      hasAudio: !!audioCodec,
      width,
      height,
      frameCount: estimatedFrameCount,
      runtimeMode: 'native',
    };
  } finally {
    input.dispose();
  }
}

export async function convertVideoToWebmWithWebCodecs(args: {
  file: File;
  inputFormat: VideoFormat;
  onProgress?: (progress01: number) => void;
  codec?: 'vp8' | 'vp09.00.10.08';
  bitrate?: number;
  framerate?: number;
  durationSec?: number;
}) {
  const { inputFormat, ...rest } = args;

  if (inputFormat === 'mp4') {
    return convertMp4ToWebmWithWebCodecs(rest);
  }

  return convertVideoToWebmWithBrowserPlayback({
    ...rest,
    framerate: undefined,
  });
}
