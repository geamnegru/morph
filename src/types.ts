export interface AudioFormat {
  id: string;
  name: string;
  ext: string;
  ffmpegCodec: string;
  sampleRate?: number;
}

export type VideoFormat = 'mp4' | 'webm' | 'avi' | 'mov' | 'mkv';
export type ConverterTab = 'video' | 'text' | 'image' | 'audio';
export type BatchFileStatus = 'waiting' | 'converting' | 'done' | 'error';

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

export interface BaseBatchFile {
  id: string;
  file: File;
  status: BatchFileStatus;
  resultUrl: string | null;
  resultSize: number | null;
  error: string | null;
}

export interface AudioBatchFile extends BaseBatchFile {
  progress: number;
  outputExt: string;
}

export interface ImageBatchFile extends BaseBatchFile {
  progress: number;
}

export type TextBatchFile = BaseBatchFile;

export interface VideoBatchFile extends BaseBatchFile {
  inFmt: VideoFormat;
  progress: number;
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

export type ConvertRequest = {
  id: string;
  blob: Blob;
  mimeOut: string;
  quality?: number;
};

export type ProgressResponse = {
  id: string;
  progress: number;
};

export type SuccessResponse = {
  id: string;
  progress: 100;
  resultBlob: Blob;
  resultSize: number;
};

export type ErrorResponse = {
  id: string;
  error: string;
};

export type DecodedImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type Mp4WritableBox = {
  write: (stream: { buffer: ArrayBuffer }) => void;
};

export type Mp4SampleEntry = {
  avcC?: Mp4WritableBox;
  hvcC?: Mp4WritableBox;
  vpcC?: Mp4WritableBox;
  av1C?: Mp4WritableBox;
};

export type Mp4BoxTrackNode = {
  mdia?: {
    minf?: {
      stbl?: {
        stsd?: {
          entries?: Mp4SampleEntry[];
        };
      };
    };
  };
};

export type Mp4DataStreamCtor = {
  new(buffer?: ArrayBuffer, byteOffset?: number, endianness?: number): {
    buffer: ArrayBuffer;
  };
  BIG_ENDIAN: number;
};

export type Mp4TrackInfo = {
  id: number;
  codec: string;
  timescale: number;
  video: { width: number; height: number };
  audio: { sample_rate: number; channel_count: number };
};

export type Mp4FileInfo = {
  videoTracks?: Mp4TrackInfo[];
  audioTracks?: Mp4TrackInfo[];
};

export type Mp4Sample = {
  is_sync?: boolean;
  cts: number;
  duration: number;
  timescale: number;
  data: ArrayBufferLike;
  number: number;
};

export type Mp4BoxFile = {
  onError: ((error: unknown) => void) | null;
  onReady: ((info: Mp4FileInfo) => void) | null;
  onSamples: ((trackId: number, user: unknown, samples: Mp4Sample[]) => void) | null;
  getTrackById?: (trackId: number) => Mp4BoxTrackNode | undefined;
  setExtractionOptions: (trackId: number, user?: unknown, options?: { nbSamples: number }) => void;
  start: () => void;
  releaseUsedSamples: (trackId: number, sampleNumber: number) => void;
  appendBuffer: (buffer: ArrayBuffer & { fileStart: number }) => void;
  flush: () => void;
};