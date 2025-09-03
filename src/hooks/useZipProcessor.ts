import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Types mirrored from workers/zipWorker.ts to avoid importing runtime code into the page bundle.
 * If you prefer, you can `import type { Rules } from '../workers/zipWorker'` instead.
 */
export type Rules = {
  maxCount?: number;
  maxLongEdge?: number;
  maxBytes?: number;
  quality?: number;
  minQuality?: number;
  stepDownRatio?: number;
  keepEXIF?: boolean;
};

export type ItemResult = {
  name: string;
  status: 'kept' | 'processed' | 'skip' | 'error';
  size?: number;
  originalSize?: number;
  reason?: string;
};

type WorkerMsg =
  | { type: 'progress'; payload: any }
  | { type: 'done'; jobId: string; blob: Blob };

/**
 * useZipProcessor
 * - Spawns a Web Worker that unzips -> validates -> (optionally) resizes/re-encodes -> rezips images.
 * - Reports per-file progress and overall progress.
 * - Produces a final ZIP Blob for download or upload to server.
 */
export function useZipProcessor() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 });
  const [list, setList] = useState<ItemResult[]>([]);
  const [output, setOutput] = useState<Blob | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (workerRef.current) workerRef.current.terminate();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
    setProgress({ processed: 0, total: 0 });
    setList([]);
    setOutput(null);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;

    // NOTE: Vite / CRA (Webpack 5) both support this `new URL(..., import.meta.url)` pattern
    const worker = new Worker(new URL('../workers/zipWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const p = (msg as any).payload;
        if (p.type === 'overall') {
          setProgress({ processed: p.processed, total: p.total });
        } else {
          setList((prev) => [
            ...prev,
            { name: p.name, status: p.type as ItemResult['status'], size: p.size, originalSize: p.originalSize, reason: p.reason },
          ]);
        }
      } else if (msg.type === 'done') {
        setBusy(false);
        setError(null);
        setOutput(msg.blob);
      }
    };

    worker.onerror = (err) => {
      setBusy(false);
      setError(err?.message || 'Worker error');
    };

    workerRef.current = worker;
    return workerRef.current;
  }, []);

  const processZip = useCallback(
    async (zipFile: File | Blob, rules: Rules) => {
      reset();
      setBusy(true);
      setError(null);
      const w = ensureWorker();
      const jobId = crypto.randomUUID();
      jobIdRef.current = jobId;
      try {
        const buf = await zipFile.arrayBuffer();
        w.postMessage({ jobId, zipFile: buf, rules });
      } catch (e: any) {
        setBusy(false);
        setError(e?.message || 'Failed to read ZIP');
      }
    },
    [ensureWorker, reset],
  );

  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setBusy(false);
  }, []);

  const outputUrl = useMemo(() => {
    if (!output) return null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(output);
    objectUrlRef.current = url;
    return url;
  }, [output]);

  return {
    // state
    busy,
    error,
    progress,
    list,
    output,
    outputUrl,
    // actions
    processZip,
    reset,
    cancel,
  };
}
