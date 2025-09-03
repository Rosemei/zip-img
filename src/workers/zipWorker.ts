/// <reference lib="webworker" />
/*
  workers/zipWorker.ts  — JPEG + PNG 支援版（force transcode）
  Responsibilities:
  - Receive a ZIP (ArrayBuffer) + rules
  - Unzip in worker (fflate)
  - Validate file type (.jpg/.jpeg/.png + magic number)
  - Decode → rotate (EXIF for JPEG) → resize/reencode to meet (maxLongEdge, maxBytes)
  - Repack to ZIP and post back as Blob
  - Report progress for each entry and overall

  Notes for PNG:
  - PNG 一律先「轉成 JPEG」再按規則壓縮（透明區域會被白底填充）。
  - PNG 無有效品質旋鈕；最終檔案大小仍以 JPEG 的品質二分搜尋 + 需要時縮圖達成。
  - `rules.format` 仍存在，但對 PNG 會被忽略（固定輸出 JPEG）。
*/

import { unzipSync, zipSync } from 'fflate';
import * as exifr from 'exifr';

export type Rules = {
  maxCount?: number;            // default 200
  maxLongEdge?: number;         // px, e.g. 1600
  maxBytes?: number;            // e.g. 500 * 1024
  quality?: number;             // JPEG: 0.5~0.95, default 0.82
  minQuality?: number;          // JPEG: default 0.5
  stepDownRatio?: number;       // when size still too large, shrink dims * this (e.g. 0.9)
  keepEXIF?: boolean;           // default false: strip EXIF (canvas re-encode drops metadata by default)
  format?: 'jpeg' | 'png' | 'auto'; // 決定輸出格式；'auto' 依輸入檔格式；default 'jpeg'
};

export type WorkerIn = {
  jobId: string;
  zipFile: ArrayBuffer;
  rules: Rules;
};

export type ProgressMsg =
  | { type: 'overall'; processed: number; total: number }
  | { type: 'kept' | 'processed'; name: string; reason?: string; size?: number; originalSize?: number; inFmt?: 'jpeg' | 'png'; outFmt?: 'jpeg' | 'png' }
  | { type: 'skip' | 'error'; name: string; reason?: string; size?: number };

export type WorkerOut =
  | { type: 'progress'; payload: ProgressMsg }
  | { type: 'done'; jobId: string; blob: Blob };

const postProgress = (msg: ProgressMsg) => (postMessage as any)({ type: 'progress', payload: msg } satisfies WorkerOut);

const sanitizeName = (raw: string) => {
  const name = raw.replace(/\\/g, '/').split('/').pop() || 'image.jpg';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
};

const isJPEGExt = (name: string) => /\.(jpe?g)$/i.test(name);
const isPNGExt  = (name: string) => /\.(png)$/i.test(name);

const isJPEGMagic = (bytes: Uint8Array) =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

const isPNGMagic = (bytes: Uint8Array) =>
  bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
  bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;

const detectImageType = (name: string, bytes: Uint8Array): 'jpeg' | 'png' | null => {
  if ((isJPEGExt(name) || !isPNGExt(name)) && isJPEGMagic(bytes)) return 'jpeg';
  if (isPNGExt(name) && isPNGMagic(bytes)) return 'png';
  if (isPNGMagic(bytes)) return 'png';
  if (isJPEGMagic(bytes)) return 'jpeg';
  return null;
};

const blobFromU8 = (u8: Uint8Array, type = 'application/octet-stream') =>
  new Blob([new Uint8Array(Array.from(u8)).buffer], { type });

async function decodeToBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in self && typeof (self as any).createImageBitmap === 'function') {
    return await createImageBitmap(blob);
  }
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

function rotateCtx(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, w: number, h: number, orientation?: number) {
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
  }
}

function targetSize({ width, height }: { width: number; height: number }, maxLongEdge?: number) {
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
  outFmt: 'jpeg' | 'png',
  quality = 0.82,
): Promise<Blob> {
  const mime = outFmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  const swap = orientation === 6 || orientation === 8;
  const outW = swap ? dims.height : dims.width;
  const outH = swap ? dims.width : dims.height;

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d', { alpha: outFmt === 'png' })!;
    if (outFmt === 'jpeg') {
      (ctx as any).fillStyle = '#fff';
      (ctx as any).fillRect(0, 0, outW, outH);
    }
    if (orientation === 6 || orientation === 8 || orientation === 3) {
      rotateCtx(ctx as any, outW, outH, orientation);
    }
    (ctx as any).drawImage(source as any, 0, 0, dims.width, dims.height);
    if ('convertToBlob' in canvas) {
      // @ts-ignore
      return await (canvas as any).convertToBlob({ type: mime, quality: outFmt === 'jpeg' ? quality : undefined });
    }
    // @ts-ignore
    return await new Promise<Blob>((resolve) => (canvas as any).toBlob(resolve, mime, outFmt === 'jpeg' ? quality : undefined));
  }
  throw new Error('OffscreenCanvas not supported in worker');
}

async function meetSizeLimitJPEG(
  source: ImageBitmap | HTMLImageElement,
  orientation: number | undefined,
  dims: { width: number; height: number },
  rules: Rules,
): Promise<Blob> {
  const maxBytes = rules.maxBytes || Infinity;
  let low = rules.minQuality ?? 0.5;
  let high = rules.quality ?? 0.82;
  let lastGood: Blob | null = null;
  for (let i = 0; i < 8; i++) {
    const q = (low + high) / 2;
    const blob = await drawAndEncode(source, orientation, dims, 'jpeg', q);
    const size = blob.size;
    if (size <= maxBytes) { lastGood = blob; high = q; } else { low = q; }
  }
  if (lastGood && lastGood.size <= maxBytes) return lastGood;
  const ratio = rules.stepDownRatio ?? 0.9;
  const next = { width: Math.max(1, Math.round(dims.width * ratio)), height: Math.max(1, Math.round(dims.height * ratio)) };
  if (next.width === dims.width && next.height === dims.height) {
    return lastGood ?? (await drawAndEncode(source, orientation, dims, 'jpeg', rules.minQuality ?? 0.5));
  }
  return meetSizeLimitJPEG(source, orientation, next, rules);
}

async function meetSizeLimitPNG(
  source: ImageBitmap | HTMLImageElement,
  orientation: number | undefined,
  dims: { width: number; height: number },
  rules: Rules,
): Promise<Blob> {
  const maxBytes = rules.maxBytes || Infinity;
  const blob = await drawAndEncode(source, orientation, dims, 'png');
  if (blob.size <= maxBytes) return blob;
  const ratio = rules.stepDownRatio ?? 0.9;
  const next = { width: Math.max(1, Math.round(dims.width * ratio)), height: Math.max(1, Math.round(dims.height * ratio)) };
  if (next.width === dims.width && next.height === dims.height) {
    return blob;
  }
  return meetSizeLimitPNG(source, orientation, next, rules);
}

function needProcess(bytes: Uint8Array, dims: { width: number; height: number }, rules: Rules) {
  const tooLong = !!rules.maxLongEdge && Math.max(dims.width, dims.height) > (rules.maxLongEdge as number);
  const tooBig  = !!rules.maxBytes && bytes.length > (rules.maxBytes as number);
  return tooLong || tooBig;
}

onmessage = async (evt: MessageEvent<WorkerIn>) => {
  try {
    const { jobId, zipFile, rules } = evt.data;
    const maxCount = rules.maxCount ?? 200;
    const formatPref: 'jpeg' | 'png' | 'auto' = rules.format ?? 'jpeg';

    const u8 = new Uint8Array(zipFile);
    const entries = unzipSync(u8, { filter: (file) => !file.name.endsWith('/') && !file.name.startsWith('__MACOSX/') });
    const rawNames = Object.keys(entries);
    const isHiddenish = (n: string) => n.split('/').some(part => part.startsWith('.') || part.startsWith('._'));
    const candidates = rawNames.filter(n => (/(jpe?g|png)$/i).test(n) && !isHiddenish(n));
    if (candidates.length > maxCount) {
      postProgress({ type: 'error', name: '(worker)', reason: `檔案數量超過上限 (${maxCount})，請減少圖片數量再試。` });
      return;
    }
    const names = candidates;
    console.log('rawNames', rawNames.length, rawNames);
    console.log('candidates', candidates.length, candidates);

    postProgress({ type: 'overall', processed: 0, total: names.length });
    const out: Record<string, Uint8Array> = {};
    let processed = 0;

    for (const rawName of names) {
      const name = sanitizeName(rawName);

      const fileU8 = entries[rawName];
      const inFmt = detectImageType(name, fileU8);
      if (!inFmt) { postProgress({ type: 'skip', name, reason: 'unsupported' }); continue; }

      const blob = blobFromU8(fileU8, inFmt === 'jpeg' ? 'image/jpeg' : 'image/png');

      let orientation: number | undefined;
      if (inFmt === 'jpeg') {
        try { orientation = (await (exifr as any).orientation(blob)) as number | undefined; } catch {}
      }

      let bitmap: ImageBitmap | HTMLImageElement;
      try { bitmap = await decodeToBitmap(blob); } catch { postProgress({ type: 'error', name, reason: 'decode' }); continue; }

      const dims0 = getDims(bitmap);
      const originalSize = fileU8.length;
      const needs = needProcess(fileU8, dims0, rules);

      const outFmt: 'jpeg' | 'png' = (inFmt === 'png')
        ? 'jpeg' // 需求：所有 PNG 強制轉 JPEG 再縮檔
        : (formatPref === 'auto' ? inFmt : (formatPref as 'jpeg' | 'png'));
      const initialDims = targetSize(dims0, rules.maxLongEdge ?? dims0.width);

      try {
        let finalBlob: Blob;
        if (outFmt === 'jpeg') {
          finalBlob = await meetSizeLimitJPEG(bitmap, orientation, initialDims, rules);
        } else {
          finalBlob = await meetSizeLimitPNG(bitmap, orientation, initialDims, rules);
        }
        const arr = new Uint8Array(await finalBlob.arrayBuffer());
        out[name] = arr;
        const didTranscode = outFmt !== inFmt || needs; // PNG->JPEG 也算轉檔
        postProgress({ type: didTranscode ? 'processed' : 'kept', name, size: arr.length, originalSize, inFmt, outFmt });
      } catch {
        postProgress({ type: 'error', name, reason: 'process' });
      }

      processed++;
      console.log(names.length, ":names len");
      postProgress({ type: 'overall', processed, total: names.length });
    }

    const zipped = zipSync(out, { level: 6 });
    const ab = new Uint8Array(Array.from(zipped)).buffer;
    const result = new Blob([ab], { type: 'application/zip' });
    (postMessage as any)({ type: 'done', jobId, blob: result } satisfies WorkerOut);
  } catch (err) {
    (postMessage as any)({ type: 'progress', payload: { type: 'error', name: '(worker)', reason: (err as Error).message } });
  }
};
