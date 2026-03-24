/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

type ConvertRequest = {
  id: string;
  blob: Blob;
  mimeOut: string;
  quality?: number;
};

type ProgressResponse = {
  id: string;
  progress: number;
};

type SuccessResponse = {
  id: string;
  progress: 100;
  resultBlob: Blob;
  resultSize: number;
};

type ErrorResponse = {
  id: string;
  error: string;
};

const postProgress = (id: string, progress: number) => {
  const msg: ProgressResponse = { id, progress };
  self.postMessage(msg);
};

const clampQuality = (quality: number | undefined) => {
  if (typeof quality !== 'number' || Number.isNaN(quality)) return 0.9;
  return Math.max(0, Math.min(1, quality));
};

const canEncodeMime = (mime: string) => {
  return [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/avif',
  ].includes(mime);
};

self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const { id, blob, mimeOut, quality } = event.data;

  try {
    if (!blob) {
      throw new Error('Missing input blob');
    }

    if (!mimeOut || !canEncodeMime(mimeOut)) {
      throw new Error(`Unsupported output format: ${mimeOut}`);
    }

    postProgress(id, 10);

    const bitmap = await createImageBitmap(blob);
    postProgress(id, 35);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { alpha: true });

    if (!ctx) {
      bitmap.close?.();
      throw new Error('Could not create OffscreenCanvas context');
    }

    ctx.clearRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    postProgress(id, 70);

    const resultBlob = await canvas.convertToBlob({
      type: mimeOut,
      quality: clampQuality(quality),
    });

    postProgress(id, 95);

    const success: SuccessResponse = {
      id,
      progress: 100,
      resultBlob,
      resultSize: resultBlob.size,
    };

    self.postMessage(success);
  } catch (err) {
    const error: ErrorResponse = {
      id,
      error: err instanceof Error ? err.message : 'Image conversion failed',
    };

    self.postMessage(error);
  }
};

export {};