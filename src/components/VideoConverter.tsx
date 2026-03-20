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

  // onSamples e apelat asincron de MP4Box pe măsură ce parsează chunk-urile
  // Folosim o coadă de promises pentru a procesa sample-urile în ordine
  // fără a acumula toate în memorie
  const sampleQueue: Promise<void>[] = [];

  mp4boxFile.onSamples = (trackId: number, _user: unknown, mp4Samples: any[]) => {
    if (processingError) return;

    if (videoTrack && trackId === videoTrack.id) {
      const videoSamples: DemuxedSample[] = mp4Samples.map((s) => ({
        isSync: !!s.is_sync,
        timestampUs: Math.round((s.cts / s.timescale) * 1_000_000),
        durationUs: Math.round((s.duration / s.timescale) * 1_000_000),
        data: new Uint8Array(s.data),
      }));

      // Eliberăm sample-urile din MP4Box imediat după copiere
      mp4boxFile.releaseUsedSamples(trackId, mp4Samples[mp4Samples.length - 1].number);

      const p = callbacks.onVideoSamples(videoSamples).catch((err) => {
        processingError = err;
        callbacks.onError(err);
      });
      sampleQueue.push(p);
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

  // Citim fișierul în chunk-uri de DEMUX_CHUNK_BYTES
  let offset = 0;
  await readyPromise;

  while (offset < file.size) {
    if (processingError) throw processingError;

    const end = Math.min(offset + DEMUX_CHUNK_BYTES, file.size);
    const slice = file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer() as MP4BoxArrayBuffer;
    arrayBuffer.fileStart = offset;

    mp4boxFile.appendBuffer(arrayBuffer);
    offset = end;

    // Yield după fiecare chunk ca să lăsăm onSamples să fie apelat
    await yieldToEventLoop();
  }

  mp4boxFile.flush();

  // Așteptăm toate sample-urile să fie procesate
  await Promise.all(sampleQueue);

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
}): Promise<Blob> {
  const {
    videoChunks,
    width,
    height,
    codec,
    framerate = 30,
  } = args;

  if (!videoChunks.length) {
    throw new Error('Nu există chunk-uri video encodate pentru mux WebM.');
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

  for (const chunkRecord of videoChunks) {
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
  requestedBitrate: number;
}): number {
  const pixels = args.width * args.height;

  if (pixels <= 640 * 360) {
    return Math.min(args.requestedBitrate, 700_000);
  }

  if (pixels <= 1280 * 720) {
    return Math.min(args.requestedBitrate, 1_200_000);
  }

  return Math.min(args.requestedBitrate, 1_800_000);
}

async function muxAudioIntoWebmWithFFmpeg(args: {
  ffmpeg: FFmpeg;
  videoOnlyBlob: Blob;
  originalFile: File;
}): Promise<Blob> {
  const { ffmpeg, videoOnlyBlob, originalFile } = args;

  const ts = Date.now();
  const videoWebmName = `__wc_video_${ts}.webm`;
  const originalMp4Name = `__wc_orig_${ts}.mp4`;
  const outputName = `__wc_muxed_${ts}.webm`;

  try {
    const videoBytes = new Uint8Array(await videoOnlyBlob.arrayBuffer());
    await ffmpeg.writeFile(videoWebmName, videoBytes);

    const mp4Bytes = await fetchFile(originalFile);
    await ffmpeg.writeFile(originalMp4Name, mp4Bytes);

    // Copiem video stream din WebM, re-encodăm audio din MP4 cu libvorbis
    await ffmpeg.exec([
      '-i', videoWebmName,
      '-i', originalMp4Name,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'libvorbis',
      '-b:a', '128k',
      outputName,
    ]);

    const outputData = await ffmpeg.readFile(outputName);
    if (typeof outputData === 'string') {
      throw new Error('FFmpeg audio mux: output binar așteptat, primit text.');
    }

    const safeBytes = new Uint8Array(outputData.byteLength);
    safeBytes.set(outputData);
    return new Blob([safeBytes], { type: 'video/webm' });
  } finally {
    for (const name of [videoWebmName, originalMp4Name, outputName]) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
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
  } = args;

  // ── Pasul 1: citim doar primul chunk pentru metadata + gate check ──────────
  const demuxStartedAt = performance.now();
  const { videoTrack: gateVideoTrack, audioTrack: gateAudioTrack, videoSamples: gateSamples } = await demuxMp4(file);

  if (!gateVideoTrack) throw new Error('Nu există track video.');
  if (!gateSamples.length) throw new Error('Nu există sample-uri video.');
  if (!gateSamples[0].isSync) throw new Error('Primul sample MP4 nu este keyframe.');

  const runtime = await getWebCodecsRuntime({
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
    framerate,
    bitrate,
    preferredCodec: codec,
  });

  const tunedBitrate = getTargetWebCodecsBitrate({
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
    requestedBitrate: bitrate,
  });

  const { isFirefox, isChrome } = getBrowserHints();
  const keyframeInterval = isFirefox ? 300 : isChrome ? 600 : 480;
  const firefoxMaxQueueSize = 32;
  const hwAccel = runtime.hardwareAcceleration;

  console.log('[WebCodecs runtime]', {
    mode: runtime.mode,
    codec,
    sourceVideoCodec: gateVideoTrack.codec,
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
    framerate,
    bitrateRequested: bitrate,
    bitrateUsed: tunedBitrate,
    browser: isFirefox ? 'firefox' : isChrome ? 'chrome' : 'other',
    keyframeInterval,
    hasAudio: !!gateAudioTrack,
  });

  // ── Pasul 2: setup encoder + decoder ──────────────────────────────────────
  const pipelineStartedAt = performance.now();

  const encodedVideoChunks: EncodedChunkRecord[] = [];
  let decodedVideoCount = 0;
  let encodedVideoCount = 0;
  let totalSampleCount = 0; // actualizat pe măsură ce vin sample-urile
  let videoDecoderError: unknown = null;
  let videoEncoderError: unknown = null;

  const videoDecoderConfig: VideoDecoderConfig = {
    codec: gateVideoTrack.codec,
    codedWidth: gateVideoTrack.width,
    codedHeight: gateVideoTrack.height,
    hardwareAcceleration: hwAccel,
  };

  if (gateVideoTrack.description?.byteLength) {
    videoDecoderConfig.description = gateVideoTrack.description;
  }

  // Queue de frames decoded care așteaptă să fie encodate (Firefox path)
  const decodedFramesQueue: VideoFrame[] = [];
  let demuxDone = false;

  // ── Encoder — comun pentru Chrome și Firefox ────────────────────────────────
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
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
    bitrate: tunedBitrate,
    framerate,
    latencyMode: 'realtime',
    hardwareAcceleration: hwAccel,
  });

  // ── Decoder ────────────────────────────────────────────────────────────────
  const videoDecoder = new runtime.VideoDecoderCtor({
    output: (frame: VideoFrame) => {
      if (isChrome) {
        // Chrome: encodăm direct în callback — sync path, zero queue overhead
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
        // Firefox: punem în queue, pump-ul le preia asincron
        decodedFramesQueue.push(frame);
      }
    },
    error: (e: DOMException) => {
      console.error('[WebCodecs video decoder error]', e);
      videoDecoderError = e;
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

  await demuxMp4Streaming(file, {
    onReady: (_vt, audioTrk) => {
      hasAudio = !!audioTrk;
    },
    onVideoSamples: async (samples) => {
      if (videoDecoderError) throw videoDecoderError;
      if (videoEncoderError) throw videoEncoderError;

      totalSampleCount += samples.length;

      for (const sample of samples) {
        const chunk = new runtime.EncodedVideoChunkCtor({
          type: sample.isSync ? 'key' : 'delta',
          timestamp: sample.timestampUs,
          duration: sample.durationUs,
          data: sample.data,
        });
        videoDecoder.decode(chunk);
      }

      // Yield după fiecare batch de sample-uri
      // lasă decoder-ul + encoder-ul să lucreze înainte de batch-ul următor
      await yieldToEventLoop();
    },
    onError: (err) => {
      videoDecoderError = err;
    },
  });

  const demuxEndedAt = performance.now();

  // ── Pasul 4: flush și așteptăm pipeline-ul să termine ────────────────────
  await videoDecoder.flush();
  demuxDone = true;

  if (pumpPromise) await pumpPromise;

  if (videoDecoderError) throw videoDecoderError;
  if (videoEncoderError) throw videoEncoderError;

  await videoEncoder.flush();

  if (videoDecoderError) throw videoDecoderError;
  if (videoEncoderError) throw videoEncoderError;

  videoDecoder.close();

  const pipelineEndedAt = performance.now();
  videoEncoder.close();

  // ── Pasul 5: mux WebM ────────────────────────────────────────────────────
  const muxStartedAt = performance.now();
  const blob = await muxWebMFromEncodedChunks({
    videoChunks: encodedVideoChunks,
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
    codec,
    framerate,
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
    finalSizeBytes: blob.size,
    finalSizeHuman: formatBytes(blob.size),
    hasAudioTrack: hasAudio,
  });

  return {
    blob,
    hasAudio,
    width: gateVideoTrack.width,
    height: gateVideoTrack.height,
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
      bitrate: 1_200_000,
      framerate: sourceFps != null ? Math.max(1, Math.round(sourceFps)) : 30,
      onProgress: (p) => {
        setProgress(Math.round(p * 100));
      },
    });

    let finalBlob: Blob;

    if (wcResult.hasAudio && ffmpegRef.current && isReady) {
      // Audio mux via FFmpeg — video stream e copiat direct, doar audio se encodează
      console.log('[WebCodecs] Audio track detectat, pornesc mux audio via FFmpeg...');
      setProgress(87);

      try {
        finalBlob = await muxAudioIntoWebmWithFFmpeg({
          ffmpeg: ffmpegRef.current,
          videoOnlyBlob: wcResult.blob,
          originalFile: selectedFile,
        });
        console.log('[WebCodecs+FFmpeg audio mux] success', {
          finalSizeBytes: finalBlob.size,
          finalSizeHuman: formatBytes(finalBlob.size),
        });
      } catch (muxErr) {
        // Audio mux eșuat — returnăm video fără audio, non-fatal
        console.warn('[WebCodecs+FFmpeg audio mux] eșuat, video fără audio:', muxErr);
        finalBlob = wcResult.blob;
        setError('Audioul nu a putut fi adăugat (FFmpeg mux eșuat). Fișierul nu conține audio.');
      }
    } else if (wcResult.hasAudio && (!ffmpegRef.current || !isReady)) {
      // FFmpeg nu e gata încă
      console.warn('[WebCodecs] FFmpeg nu e gata, video fără audio.');
      finalBlob = wcResult.blob;
      setError('FFmpeg nu este încărcat încă. Fișierul nu conține audio.');
    } else {
      // Sursa nu are audio track
      console.log('[WebCodecs] Sursă fără audio, finalizăm direct.');
      finalBlob = wcResult.blob;
    }

    const url = URL.createObjectURL(finalBlob);
    setResultUrl(url);
    setResultSize(finalBlob.size);
    setEngineUsed('webcodecs');
    setProgress(100);

    console.log('[Conversion output]', {
      engine: 'webcodecs',
      audioMuxed: wcResult.hasAudio && !!ffmpegRef.current && isReady,
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
        try {
          const canUseWebCodecs = await canUseWebCodecsForMp4ToWebm(selectedFile);
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
