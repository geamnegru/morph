/// <reference lib="webworker" />

import { encode as encodeAvif } from '@jsquash/avif';
import type { ConvertRequest, DecodedImage, ErrorResponse, ProgressResponse, SuccessResponse } from '../types';
import decodeHeic from 'heic-decode';
import * as UTIF from 'utif2';

declare const self: DedicatedWorkerGlobalScope;

const postProgress = (id: string, progress: number) => {
  const msg: ProgressResponse = { id, progress };
  self.postMessage(msg);
};

const clampQuality = (quality: number | undefined) => {
  if (typeof quality !== 'number' || Number.isNaN(quality)) return 0.9;
  return Math.max(0, Math.min(1, quality));
};

const mapQualityToAvif = (quality: number | undefined) => {
  return Math.round(clampQuality(quality) * 100);
};

const canEncodeMime = (mime: string) => {
  return [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/avif',
    'image/bmp',
    'image/tiff',
  ].includes(mime);
};

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

const isHeicBrand = (bytes: Uint8Array) => {
  if (bytes.length < 12) return false;

  const brand = String.fromCharCode(...bytes.slice(8, 12)).replace(/\0/g, ' ').trim();

  return [
    'mif1',
    'msf1',
    'heic',
    'heix',
    'hevc',
    'hevx',
  ].includes(brand);
};

const shouldDecodeAsHeic = async (blob: Blob) => {
  if (HEIC_MIME_TYPES.has(blob.type)) {
    return true;
  }

  const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  return isHeicBrand(header);
};

const TIFF_HEADER_LITTLE_ENDIAN = [0x49, 0x49, 0x2A, 0x00];
const TIFF_HEADER_BIG_ENDIAN = [0x4D, 0x4D, 0x00, 0x2A];

const isTiffHeader = (bytes: Uint8Array) => {
  const matches = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  return bytes.length >= 4 && (matches(TIFF_HEADER_LITTLE_ENDIAN) || matches(TIFF_HEADER_BIG_ENDIAN));
};

const shouldDecodeAsTiff = async (blob: Blob) => {
  if (blob.type === 'image/tiff' || blob.type === 'image/tif') {
    return true;
  }

  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return isTiffHeader(header);
};

const decodeTiff = async (blob: Blob): Promise<DecodedImage> => {
  const buffer = await blob.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  const [firstIfd] = ifds;

  if (!firstIfd) {
    throw new Error('Could not decode TIFF image');
  }

  UTIF.decodeImage(buffer, firstIfd);

  return {
    width: firstIfd.width,
    height: firstIfd.height,
    data: new Uint8ClampedArray(UTIF.toRGBA8(firstIfd)),
  };
};

const encodeBmp = (imageData: ImageData) => {
  const { width, height, data } = imageData;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x42;
  bytes[1] = 0x4D;
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelArraySize, true);

  let offset = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * 4;
      bytes[offset] = data[pixelOffset + 2];
      bytes[offset + 1] = data[pixelOffset + 1];
      bytes[offset + 2] = data[pixelOffset];
      offset += 3;
    }

    while ((offset - 54) % rowSize !== 0) {
      bytes[offset] = 0;
      offset += 1;
    }
  }

  return new Blob([buffer], { type: 'image/bmp' });
};

const encodeTiff = (imageData: ImageData) => {
  const buffer = UTIF.encodeImage(new Uint8Array(imageData.data), imageData.width, imageData.height);
  return new Blob([buffer], { type: 'image/tiff' });
};

const decodeInputImage = async (blob: Blob): Promise<DecodedImage> => {
  if (await shouldDecodeAsHeic(blob)) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const decoded = await decodeHeic({ buffer });

    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    };
  }

  if (await shouldDecodeAsTiff(blob)) {
    return decodeTiff(blob);
  }

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { alpha: true });

  if (!ctx) {
    bitmap.close?.();
    throw new Error('Could not create OffscreenCanvas context');
  }

  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

const encodeAvifFallback = async (
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  quality: number | undefined
) => {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const avifBuffer = await encodeAvif(imageData, {
    quality: mapQualityToAvif(quality),
  });

  return new Blob([avifBuffer], { type: 'image/avif' });
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

    const decodedImage = await decodeInputImage(blob);
    postProgress(id, 35);

    const canvas = new OffscreenCanvas(decodedImage.width, decodedImage.height);
    const ctx = canvas.getContext('2d', { alpha: true });

    if (!ctx) {
      throw new Error('Could not create OffscreenCanvas context');
    }

    ctx.clearRect(0, 0, decodedImage.width, decodedImage.height);
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(decodedImage.data),
        decodedImage.width,
        decodedImage.height
      ),
      0,
      0
    );

    postProgress(id, 70);

    let resultBlob: Blob;

    if (mimeOut === 'image/avif') {
      const nativeBlob = await canvas.convertToBlob({
        type: mimeOut,
        quality: clampQuality(quality),
      });

      // Some browsers silently fall back to PNG even when AVIF was requested.
      resultBlob = nativeBlob.type === 'image/avif'
        ? nativeBlob
        : await encodeAvifFallback(canvas, ctx, quality);
    } else if (mimeOut === 'image/bmp') {
      resultBlob = encodeBmp(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } else if (mimeOut === 'image/tiff') {
      resultBlob = encodeTiff(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } else {
      resultBlob = await canvas.convertToBlob({
        type: mimeOut,
        quality: clampQuality(quality),
      });
    }

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
