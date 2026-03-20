export interface AudioFormat {
  id: string;
  name: string;
  ext: string;
  ffmpegCodec: string;
  sampleRate?: number;
}

export type VideoFormat = 'mp4' | 'webm' | 'avi' | 'mov' | 'mkv';

export type HTMLVideoElementWithCapture = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

export interface FormatConfig {
  accept: string;
  mimeType: string;
  extension: VideoFormat;
}

export interface TextFormat {
  id: string;
  name: string;
  ext: string;
  accept: string;
  mime: string;
}

export interface ImageFormat {
  id: string;
  name: string;
  ext: string;
  accept: string;
  mime: string;
}

export interface VideoTrackInfo {
  id: number;
  width: number;
  height: number;
  timescale: number;
  codec: string;
  nb_samples: number;
};

export interface Sample {
  is_sync: boolean;
  cts: number;
  duration: number;
  data: Uint8Array;
};

export type DemuxedAudioSample = {
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
};

export type AudioTrack = {
  id: number;
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  timescale: number;
  description?: Uint8Array;
};

export type EncodedAudioChunkRecord = {
  data: Uint8Array;
  timestamp: number;
  duration?: number;
  type: EncodedAudioChunkType;
};

export type DemuxedSample = {
  isSync: boolean;
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
};

export type VideoTrack = {
  id: number;
  codec: string;
  width: number;
  height: number;
  timescale: number;
  description?: Uint8Array;
};

export type EncodedChunkRecord = {
  data: Uint8Array;
  timestamp: number;
  duration?: number;
  type: EncodedVideoChunkType;
};

export type WebCodecsRuntime = {
  VideoEncoderCtor: typeof VideoEncoder;
  VideoDecoderCtor: typeof VideoDecoder;
  EncodedVideoChunkCtor: typeof EncodedVideoChunk;
  mode: 'native';
  hardwareAcceleration: HardwareAcceleration;
};