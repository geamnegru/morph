import type { AudioFormat, VideoFormat, FormatConfig, TextFormat, ImageFormat, ConverterTab } from './types';

export const audioInputFormats: AudioFormat[] = [
  { id: 'mp3',  name: 'MP3',  ext: 'mp3',  ffmpegCodec: 'mp3' },
  { id: 'wav',  name: 'WAV',  ext: 'wav',  ffmpegCodec: 'pcm_s16le' },
  { id: 'aac',  name: 'AAC',  ext: 'm4a',  ffmpegCodec: 'aac' },
  { id: 'm4a',  name: 'M4A',  ext: 'm4a',  ffmpegCodec: 'aac' },
  { id: 'alac', name: 'ALAC', ext: 'm4a',  ffmpegCodec: 'alac' },
  { id: 'ogg',  name: 'OGG',  ext: 'ogg',  ffmpegCodec: 'libvorbis' },
  { id: 'opus', name: 'Opus', ext: 'opus', ffmpegCodec: 'libopus' },
  { id: 'flac', name: 'FLAC', ext: 'flac', ffmpegCodec: 'flac' },
  { id: 'aiff', name: 'AIFF', ext: 'aiff', ffmpegCodec: 'pcm_s16be' },
  { id: 'aifc', name: 'AIFC', ext: 'aifc', ffmpegCodec: 'pcm_s16be' },
  { id: 'amr',  name: 'AMR',  ext: 'amr',  ffmpegCodec: 'amr_nb', sampleRate: 8000 },
  { id: 'webm', name: 'WebM Audio', ext: 'webm', ffmpegCodec: 'libvorbis' },
];

export const audioOutputFormats: AudioFormat[] = [
  { id: 'mp3', name: 'MP3', ext: 'mp3', ffmpegCodec: 'mp3', sampleRate: 44100 },
  { id: 'aac', name: 'AAC', ext: 'm4a', ffmpegCodec: 'aac', sampleRate: 44100 },
  { id: 'alac', name: 'ALAC', ext: 'm4a', ffmpegCodec: 'alac', sampleRate: 44100 },
  { id: 'ogg', name: 'OGG Vorbis', ext: 'ogg', ffmpegCodec: 'libvorbis', sampleRate: 44100 },
  { id: 'flac', name: 'FLAC', ext: 'flac', ffmpegCodec: 'flac' },
  { id: 'opus', name: 'Opus', ext: 'webm', ffmpegCodec: 'libopus', sampleRate: 48000 },
  { id: 'wav', name: 'WAV', ext: 'wav', ffmpegCodec: 'pcm_s16le', sampleRate: 44100 },
  { id: 'aifc', name: 'AIFC', ext: 'aifc', ffmpegCodec: 'pcm_s16be', sampleRate: 44100 },
  { id: 'amr', name: 'AMR', ext: 'amr', ffmpegCodec: 'amr_nb', sampleRate: 8000 },
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
  { id: 'xml',  name: 'XML',      ext: 'xml',  accept: '.xml',       mime: 'application/xml' },
  { id: 'toml', name: 'TOML',     ext: 'toml', accept: '.toml',      mime: 'application/toml' },
  { id: 'html', name: 'HTML',     ext: 'html', accept: '.html,.htm', mime: 'text/html' },
  { id: 'base64', name: 'Base64', ext: 'b64',  accept: '.b64,.base64,.txt', mime: 'text/plain' },
  { id: 'log',  name: 'LOG',      ext: 'log',  accept: '.log',       mime: 'text/plain' },
];

export const textOutputFormats: TextFormat[] = [
  { id: 'txt',  name: 'TXT',      ext: 'txt',  accept: '.txt',  mime: 'text/plain' },
  { id: 'json', name: 'JSON',     ext: 'json', accept: '.json', mime: 'application/json' },
  { id: 'yaml', name: 'YAML',     ext: 'yml',  accept: '.yml',  mime: 'text/yaml' },
  { id: 'csv',  name: 'CSV',      ext: 'csv',  accept: '.csv',  mime: 'text/csv' },
  { id: 'md',   name: 'Markdown', ext: 'md',   accept: '.md',   mime: 'text/markdown' },
  { id: 'xml',  name: 'XML',      ext: 'xml',  accept: '.xml',  mime: 'application/xml' },
  { id: 'toml', name: 'TOML',     ext: 'toml', accept: '.toml', mime: 'application/toml' },
  { id: 'html', name: 'HTML',     ext: 'html', accept: '.html', mime: 'text/html' },
  { id: 'base64', name: 'Base64', ext: 'b64',  accept: '.b64',  mime: 'text/plain' },
];

export const imageInputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg,.jpeg', mime: 'image/jpeg' },
  { id: 'svg', name: 'SVG', ext: 'svg', accept: '.svg', mime: 'image/svg+xml' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' },
  { id: 'bmp', name: 'BMP', ext: 'bmp', accept: '.bmp', mime: 'image/bmp' },
  { id: 'tiff', name: 'TIFF', ext: 'tiff', accept: '.tif,.tiff', mime: 'image/tiff' },
  { id: 'heic', name: 'HEIC', ext: 'heic', accept: '.heic', mime: 'image/heic' },
  { id: 'heif', name: 'HEIF', ext: 'heif', accept: '.heif', mime: 'image/heif' }
];

export const imageOutputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg', mime: 'image/jpeg' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' },
  { id: 'bmp', name: 'BMP', ext: 'bmp', accept: '.bmp', mime: 'image/bmp' },
  { id: 'tiff', name: 'TIFF', ext: 'tiff', accept: '.tiff', mime: 'image/tiff' }
];

export const AUDIO_DROPZONE_ACCEPT = '.mp3,.wav,.m4a,.aac,.alac,.ogg,.opus,.flac,.aiff,.aif,.aifc,.amr,.webm';
export const AUDIO_DROPZONE_HINT = 'MP3, WAV, AAC, ALAC, OGG, FLAC, Opus, AIFF, AIFC, AMR, WebM';
export const IMAGE_DROPZONE_ACCEPT = '.png,.jpg,.jpeg,.svg,.webp,.avif,.gif,.bmp,.tiff,.heic,.heif';
export const IMAGE_DROPZONE_HINT = 'PNG, JPG, SVG, WebP, AVIF, HEIC, HEIF, GIF, BMP, TIFF';
export const EMPTY_BATCH_MESSAGE = 'Add files above to get started';

export const APP_TABS: Array<{ id: ConverterTab; label: string; icon: string }> = [
  { id: 'video', label: 'Video', icon: '\u25B6' },
  { id: 'audio', label: 'Audio', icon: '\u266A' },
  { id: 'image', label: 'Image', icon: '\u25A3' },
  { id: 'text', label: 'Text', icon: '\u2261' },
];

export const FFMPEG_FORMAT: Record<string, string> = {
  mp3: 'mp3', aac: 'mp4', alac: 'mp4', ogg: 'ogg', wav: 'wav', aifc: 'aiff', amr: 'amr',
};

export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', aac: 'audio/mp4', alac: 'audio/mp4',
  ogg: 'audio/ogg; codecs=vorbis',
  wav: 'audio/wav', opus: 'audio/webm; codecs=opus', aifc: 'audio/aiff', amr: 'audio/amr',
};

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
};
export const QUALITY_MAP: Record<string, number> = {
  png: 1,
  jpg: 0.88,
  webp: 0.90,
  avif: 0.85,
  bmp: 1,
  tiff: 1,
};
