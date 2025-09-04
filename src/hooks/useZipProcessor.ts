import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  size?: number;          // bytes
  originalSize?: number;  // bytes
  reason?: string;
};

type WorkerMsg =
  | { type: 'progress'; payload: any }
  | { type: 'done-stream'; jobId: string }
  | { type: 'zip-chunk'; chunk: Uint8Array };   // 🔧 worker 傳的是 Uint8Array（且使用 transferable）

export function useZipProcessor() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 });
  const [list, setList] = useState<ItemResult[]>([]);
  const [output, setOutput] = useState<Blob | null>(null);
  const [inputName, setInputName] = useState<string | null>(null);


  const workerRef = useRef<Worker | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const chunksRef = useRef<Uint8Array[]>([]); 
  const jobIdRef = useRef<string | null>(null);
  const startTsRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
    setProgress({ processed: 0, total: 0 });
    setList([]);
    setOutput(null);
    chunksRef.current = [];
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL('../workers/zipWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;

      if (msg.type === 'zip-chunk') {
        if (msg.chunk && msg.chunk.byteLength) {
          chunksRef.current.push(msg.chunk);
        }
        return;
      }

      if (msg.type === 'done-stream') {
        console.log('done-stream')
        const zipBlob = new Blob(chunksRef.current, { type: 'application/zip' });
        chunksRef.current = []; // 釋放
        setOutput(zipBlob);
        setBusy(false);
        setError(null);
        const end = performance.now();
        const start = startTsRef.current ?? end;
        const elapsedMs = Math.max(0, Math.round(end - start));
        setProgress((prev) => ({ ...prev, elapsedMs }));
        return;
      }

      if (msg.type === 'progress') {
        const p = (msg as any).payload;

        if (p.type === 'overall') {
          setProgress({ processed: p.processed ?? 0, total: p.total ?? 0 });
          return;
        }

        const size = typeof p.size === 'number' ? p.size : undefined;
        const originalSize = typeof p.originalSize === 'number' ? p.originalSize : undefined;
        console.log(p, ":p")

        setList(prev => prev.concat({
          name: p.name,
          status: p.type as ItemResult['status'],
          size,
          originalSize,
          reason: p.reason,
        }));
        return;
      }
    };

    worker.onerror = (err: any) => {
      setBusy(false);
      setError(err?.message || 'Worker error');
    };

    workerRef.current = worker;
    return worker;
  }, []);

  const processZip = useCallback(
    async (zipFile: File | Blob, rules: Rules) => {
      reset();//Clear old state 
      setBusy(true);
      setError(null);

      startTsRef.current = performance.now();

      if (zipFile instanceof File) {
        const base = zipFile.name.replace(/\.zip$/i, "");
        setInputName(base);
      } else {
        setInputName("input");
      }

      const w = ensureWorker();
      const jobId = crypto.randomUUID();
      jobIdRef.current = jobId;

      try {
        const buf = await zipFile.arrayBuffer();
        // 可選：把 jobId 傳進去（目前 worker 不用也沒關係）
        w.postMessage({ jobId, zipFile: buf, rules }, [buf]);   // 🔧 transfer ZIP buffer 進 worker
      } catch (e: any) {
        setBusy(false);
        setError(e?.message || 'Failed to read ZIP');
      }
    },
    [ensureWorker, reset],
  );

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
  }, []);

  const outputUrl = useMemo(() => {
    if (!output) return null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(output);
    objectUrlRef.current = url;
    return url;
  }, [output]);

  return { busy, error, progress, list, output, outputUrl, processZip, reset, cancel, inputName };
}
