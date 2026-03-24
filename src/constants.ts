import type { AudioFormat, VideoFormat, FormatConfig, TextFormat, ImageFormat } from './types';

export const audioInputFormats: AudioFormat[] = [
  { id: 'mp3',  name: 'MP3',  ext: 'mp3',  ffmpegCodec: 'mp3' },
  { id: 'wav',  name: 'WAV',  ext: 'wav',  ffmpegCodec: 'pcm_s16le' },
  { id: 'aac',  name: 'AAC',  ext: 'm4a',  ffmpegCodec: 'aac' },
  { id: 'm4a',  name: 'M4A',  ext: 'm4a',  ffmpegCodec: 'aac' },
  { id: 'ogg',  name: 'OGG',  ext: 'ogg',  ffmpegCodec: 'libvorbis' },
  { id: 'opus', name: 'Opus', ext: 'opus', ffmpegCodec: 'libopus' },
  { id: 'flac', name: 'FLAC', ext: 'flac', ffmpegCodec: 'flac' },
  { id: 'aiff', name: 'AIFF', ext: 'aiff', ffmpegCodec: 'pcm_s16be' },
  { id: 'webm', name: 'WebM Audio', ext: 'webm', ffmpegCodec: 'libvorbis' },
];

export const audioOutputFormats: AudioFormat[] = [
  { id: 'mp3', name: 'MP3', ext: 'mp3', ffmpegCodec: 'mp3', sampleRate: 44100 },
  { id: 'aac', name: 'AAC', ext: 'm4a', ffmpegCodec: 'aac', sampleRate: 44100 },
  { id: 'ogg', name: 'OGG Vorbis', ext: 'ogg', ffmpegCodec: 'libvorbis', sampleRate: 44100 },
  { id: 'flac', name: 'FLAC', ext: 'flac', ffmpegCodec: 'flac' },
  { id: 'opus', name: 'Opus', ext: 'webm', ffmpegCodec: 'libopus', sampleRate: 48000 },
  { id: 'wav', name: 'WAV', ext: 'wav', ffmpegCodec: 'pcm_s16le', sampleRate: 44100 },
];


export const FORMATS: Record<VideoFormat, FormatConfig> = {
  mp4: { accept: '.mp4', mimeType: 'video/mp4', extension: 'mp4' },
  webm: { accept: '.webm', mimeType: 'video/webm', extension: 'webm' },
  avi: { accept: '.avi', mimeType: 'video/x-msvideo', extension: 'avi' },
  mov: { accept: '.mov', mimeType: 'video/quicktime', extension: 'mov' },
  mkv: { accept: '.mkv', mimeType: 'video/x-matroska', extension: 'mkv' },
};

export const COPY_COMPATIBLE_FORMATS: VideoFormat[] = ['mp4', 'mkv', 'avi', 'mov'];

export const WEBM_MIME_CANDIDATES = [
  'video/webm;codecs=vp8,vorbis',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
];

export const textInputFormats: TextFormat[] = [
  { id: 'txt',  name: 'TXT',      ext: 'txt',  accept: '.txt',       mime: 'text/plain' },
  { id: 'json', name: 'JSON',     ext: 'json', accept: '.json',      mime: 'application/json' },
  { id: 'yaml', name: 'YAML',     ext: 'yml',  accept: '.yaml,.yml', mime: 'text/yaml' },
  { id: 'csv',  name: 'CSV',      ext: 'csv',  accept: '.csv',       mime: 'text/csv' },
  { id: 'md',   name: 'Markdown', ext: 'md',   accept: '.md',        mime: 'text/markdown' },
  { id: 'log',  name: 'LOG',      ext: 'log',  accept: '.log',       mime: 'text/plain' },
];

export const textOutputFormats: TextFormat[] = [
  { id: 'txt',  name: 'TXT',      ext: 'txt',  accept: '.txt',  mime: 'text/plain' },
  { id: 'json', name: 'JSON',     ext: 'json', accept: '.json', mime: 'application/json' },
  { id: 'yaml', name: 'YAML',     ext: 'yml',  accept: '.yml',  mime: 'text/yaml' },
  { id: 'csv',  name: 'CSV',      ext: 'csv',  accept: '.csv',  mime: 'text/csv' },
  { id: 'md',   name: 'Markdown', ext: 'md',   accept: '.md',   mime: 'text/markdown' },
];

export const imageInputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg,.jpeg', mime: 'image/jpeg' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' }
];

export const imageOutputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg', mime: 'image/jpeg' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' }
];