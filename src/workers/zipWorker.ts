/// <reference lib="webworker" />
/*
  workers/zipWorker.ts
  Responsibilities:
  - Receive a ZIP (ArrayBuffer) + rules
  - Unzip in worker (fflate)
  - Validate file type (.jpg/.jpeg + magic number)
  - Decode → resize/reencode to meet (maxLongEdge, maxBytes)
  - Repack to ZIP and post back as Blob
  - Report progress for each entry and overall
*/

import { unzipSync, zipSync } from 'fflate';
import * as exifr from 'exifr';

export type Rules = {
  maxCount?: number;            // default 200
  maxLongEdge?: number;         // px, e.g. 1600
  maxBytes?: number;            // e.g. 500 * 1024
  quality?: number;             // 0.5~0.95, default 0.82
  minQuality?: number;          // default 0.5
  stepDownRatio?: number;       // when quality too low, shrink dims * this (e.g. 0.9)
  keepEXIF?: boolean;           // default false: strip EXIF (canvas re-encode drops metadata by default)
};

export type WorkerIn = {
  jobId: string;
  zipFile: ArrayBuffer;
  rules: Rules;
};

export type ProgressMsg =
  | { type: 'overall'; processed: number; total: number }
  | { type: 'kept' | 'processed' | 'skip' | 'error'; name: string; reason?: string; size?: number };

export type WorkerOut =
  | { type: 'progress'; payload: ProgressMsg }
  | { type: 'done'; jobId: string; blob: Blob };

const postProgress = (msg: ProgressMsg) => (postMessage as any)({ type: 'progress', payload: msg } satisfies WorkerOut);

const sanitizeName = (raw: string) => {
  // strip directories & normalize
  const name = raw.replace(/\\/g, '/').split('/').pop() || 'image.jpg';
  // collapse spaces & dangerous chars
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
};

const isJPEGExt = (name: string) => /\.(jpe?g)$/i.test(name);

const isJPEGMagic = (bytes: Uint8Array) => 
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

const blobFromU8 = (u8: Uint8Array, type = 'application/octet-stream') => new Blob([u8], { type });

async function decodeToBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in self && typeof (self as any).createImageBitmap === 'function') {
    return await createImageBitmap(blob);
  }
  // Fallback: decode using HTMLImageElement (not ideal in worker unless OffscreenCanvas supported)
  // Safari workers may not decode; in that case we expect main thread fallback path.
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function getDims(source: ImageBitmap | HTMLImageElement) {
  return { width: (source as any).width, height: (source as any).height };
}

function rotateCtx(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, orientation?: number) {
  // Only basic orientations 3, 6, 8 are common; others rarely appear
  switch (orientation) {
    case 3:
      ctx.translate(w, h); ctx.rotate(Math.PI);
      break;
    case 6:
      ctx.translate(h, 0); ctx.rotate(Math.PI / 2);
      break;
    case 8:
      ctx.translate(0, w); ctx.rotate(-Math.PI / 2);
      break;
    default:
      // no-op
  }
}

function targetSize({ width, height }: { width: number; height: number }, maxLongEdge: number) {
  if (!maxLongEdge) return { width, height };
  const long = Math.max(width, height);
  if (long <= maxLongEdge) return { width, height };
  const ratio = maxLongEdge / long;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function drawAndEncode(
  source: ImageBitmap | HTMLImageElement,
  orientation: number | undefined,
  dims: { width: number; height: number },
  mime = 'image/jpeg',
  quality = 0.82,
): Promise<Blob> {
  // Adjust canvas size for orientation that swaps w/h
  const swap = orientation === 6 || orientation === 8;
  const outW = swap ? dims.height : dims.width;
  const outH = swap ? dims.width : dims.height;

  // Use OffscreenCanvas in worker
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    // background white to avoid transparent black
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);

    if (orientation === 6 || orientation === 8 || orientation === 3) {
      rotateCtx(ctx as any, outW, outH, orientation);
    }
    ctx.drawImage(source as any, 0, 0, dims.width, dims.height);

    if ('convertToBlob' in canvas) {
      // @ts-ignore
      return await (canvas as any).convertToBlob({ type: mime, quality });
    }
    // @ts-ignore
    return await new Promise<Blob>((resolve) => (canvas as any).toBlob(resolve, mime, quality));
  }

  // No OffscreenCanvas → throw; main thread should fallback handle
  throw new Error('OffscreenCanvas not supported in worker');
}

async function meetSizeLimit(
  source: ImageBitmap | HTMLImageElement,
  orientation: number | undefined,
  dims: { width: number; height: number },
  rules: Rules,
): Promise<Blob> {
  const maxBytes = rules.maxBytes || Infinity;
  let low = rules.minQuality ?? 0.5;
  let high = rules.quality ?? 0.82;
  let lastGood: Blob | null = null;

  for (let i = 0; i < 8; i++) { // binary search steps
    const q = (low + high) / 2;
    const blob = await drawAndEncode(source, orientation, dims, 'image/jpeg', q);
    const size = blob.size;
    if (size <= maxBytes) {
      lastGood = blob; high = q;
    } else {
      low = q;
    }
  }

  if (lastGood && lastGood.size <= maxBytes) return lastGood;

  // Still too large → downscale and retry
  const ratio = rules.stepDownRatio ?? 0.9;
  const next = { width: Math.max(1, Math.round(dims.width * ratio)), height: Math.max(1, Math.round(dims.height * ratio)) };
  if (next.width === dims.width && next.height === dims.height) {
    // Give up: return best effort at minQuality
    return lastGood ?? (await drawAndEncode(source, orientation, dims, 'image/jpeg', rules.minQuality ?? 0.5));
  }
  return meetSizeLimit(source, orientation, next, rules);
}

function needProcess(bytes: Uint8Array, dims: { width: number; height: number }, rules: Rules) {
  const tooLong = !!rules.maxLongEdge && Math.max(dims.width, dims.height) > (rules.maxLongEdge as number);
  const tooBig = !!rules.maxBytes && bytes.length > (rules.maxBytes as number);
  return tooLong || tooBig;
}

onmessage = async (evt: MessageEvent<WorkerIn>) => {
  try {
    const { jobId, zipFile, rules } = evt.data;
    const maxCount = rules.maxCount ?? 200;

    const u8 = new Uint8Array(zipFile);
    const entries = unzipSync(u8, { filter: (file) => !file.name.endsWith('/') });
    const names = Object.keys(entries);

    const out: Record<string, Uint8Array> = {};
    let processed = 0;

    for (const rawName of names) {
      const name = sanitizeName(rawName);
      if (processed >= maxCount) { postProgress({ type: 'skip', name, reason: 'exceed_max_count' }); continue; }

      const fileU8 = entries[rawName];
      if (!isJPEGExt(name)) { postProgress({ type: 'skip', name, reason: 'ext' }); continue; }
      if (!isJPEGMagic(fileU8)) { postProgress({ type: 'error', name, reason: 'magic' }); continue; }

      const blob = blobFromU8(fileU8, 'image/jpeg');

      // EXIF (orientation only; strip by default later)
      let orientation: number | undefined;
      try { orientation = (await (exifr as any).orientation(blob)) as number | undefined; } catch {}

      let bitmap: ImageBitmap | HTMLImageElement;
      try {
        bitmap = await decodeToBitmap(blob);
      } catch (e) {
        postProgress({ type: 'error', name, reason: 'decode' });
        continue;
      }

      const dims0 = getDims(bitmap);
      const needs = needProcess(fileU8, dims0, rules);

      if (!needs) {
        out[name] = fileU8;
        postProgress({ type: 'kept', name, size: fileU8.length });
      } else {
        const initialDims = targetSize(dims0, rules.maxLongEdge ?? dims0.width);
        try {
          const finalBlob = await meetSizeLimit(bitmap, orientation, initialDims, rules);
          const arr = new Uint8Array(await finalBlob.arrayBuffer());
          out[name] = arr;
          postProgress({ type: 'processed', name, size: arr.length });
        } catch (e) {
          postProgress({ type: 'error', name, reason: 'process' });
        }
      }

      processed++;
      postProgress({ type: 'overall', processed, total: names.length });
    }

  const zipped = zipSync(out, { level: 6 }) as Uint8Array;
const result = new Blob([zipped], { type: 'application/zip' });
(postMessage as any)({ type: 'done', jobId, blob: result } satisfies WorkerOut);
  } catch (err) {
    (postMessage as any)({ type: 'progress', payload: { type: 'error', name: '(worker)', reason: (err as Error).message } });
  }
};
