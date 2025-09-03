# zip-img-vite-starter

React + Vite + TypeScript 範例，示範在 **Web Worker** 內解壓 ZIP、驗證 JPG/JPEG、縮圖/壓縮並重新打包 ZIP。

## 使用
```bash
yarn
yarn dev
```

部署到 Vercel：導入專案，Build Command `yarn build`，Output Dir `dist`。

## 檔案
- `src/workers/zipWorker.ts`：重活都在這裡做（unzip/validate/resize/re-zip）
- `src/hooks/useZipProcessor.ts`：與 worker 溝通、進度與結果管理
- `src/components/DropZone.tsx`：拖拉上傳 ZIP
- `src/ZipUploadPage.tsx`：簡易 UI
- `vite.config.ts`：Vite 設定（含 React plugin）

## 依賴
- `fflate`：快速壓縮/解壓
- `exifr`：讀 EXIF orientation
- `react-dropzone`：拖拉上傳
- `pica`：可選（本範例未啟用），需要更高畫質縮放時可替換


## 使用範例

```tsx
import React, { useEffect, useRef } from 'react';

export default function ZipProcessor() {
  const workerRef = useRef<Worker>();

  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../workers/zipWorker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current.onmessage = (evt) => {
      const msg = evt.data;
      if (msg.type === 'progress') {
        // msg.payload: { name, status, size, originalSize, ... }
        console.log('進度：', msg.payload);
      } else if (msg.type === 'done') {
        const url = URL.createObjectURL(msg.blob);
        // 自動下載
        const a = document.createElement('a');
        a.href = url;
        a.download = 'processed.zip';
        a.click();
      }
    };
    return () => { workerRef.current?.terminate(); };
  }, []);

  const handleFile = async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    workerRef.current?.postMessage({
      jobId: 'job-1',
      zipFile: arrayBuffer,
      rules: { maxLongEdge: 1600, maxBytes: 500 * 1024 }, // 可調整參數
    });
  };

  return (
    <input type="file" accept=".zip" onChange={e => {
      if (e.target.files?.[0]) handleFile(e.target.files[0]);
    }} />
  );
}
```

**rules 可用參數：**
- `maxLongEdge`：圖片長邊上限（px）
- `maxBytes`：檔案大小上限（bytes）
- 其他參數請參考 `src/workers/zipWorker.ts`

**進度訊息 payload 範例：**
```json
{ "name": "xxx.jpg", "status": "processed", "size": 215000, "originalSize": 512000 }
```

> 此為最簡 input 範例，實際 UI 可參考 `ZipUploadPage.tsx`

