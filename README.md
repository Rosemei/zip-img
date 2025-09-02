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
