import { useMemo, useState } from 'react'
import DropZone from './components/DropZone'
import { useZipProcessor } from './hooks/useZipProcessor'

export default function ZipUploadPage() {
  const { busy, list, outputUrl, progress, processZip, error, reset } = useZipProcessor()
  const [rules, setRules] = useState({ maxCount: 200, maxLongEdge: 1600, maxBytes: 500 * 1024, quality: 0.82, minQuality: 0.5, stepDownRatio: 0.9, keepEXIF: false })

  const reducedTotalKB = useMemo(() =>
    list.filter(x => x.status === 'processed' || x.status === 'kept').reduce((acc, x) => acc + (x.size || 0), 0) / 1024
  , [list])

  return (
    <div style={{ maxWidth: 880, margin: '40px auto', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1>ZIP 批量壓縮（JPG/JPEG）</h1>
      <p>在背景執行緒處理 200 張以內的照片，壓到指定大小與長邊。把 ZIP 拖進來就開始！</p>

      <DropZone onFile={(f) => processZip(f, rules)} />

      <fieldset style={{ marginTop: 16 }}>
        <legend>規則</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <label>長邊上限(px)<br/>
            <input type="number" value={rules.maxLongEdge} onChange={e => setRules(r => ({ ...r, maxLongEdge: Number(e.target.value) }))} />
          </label>
          <label>檔案上限(KB)<br/>
            <input type="number" value={(rules.maxBytes as number)/1024} onChange={e => setRules(r => ({ ...r, maxBytes: Number(e.target.value) * 1024 }))} />
          </label>
          <label>品質(預設)<br/>
            <input type="number" min={0.3} max={0.95} step={0.01} value={rules.quality} onChange={e => setRules(r => ({ ...r, quality: Number(e.target.value) }))} />
          </label>
        </div>
      </fieldset>

      <div style={{ marginTop: 16 }}>
        <strong>進度：</strong> {progress.processed}/{progress.total} {busy && '（處理中…）'}
        {error && <div style={{ color: 'crimson' }}>錯誤：{error} <button onClick={reset}>重置</button></div>}
        <ul style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #eee', padding: 8, marginTop: 8 }}>
          {list.map((x, i) => (
            <li key={i}>
              <code>{x.name}</code> — {x.status}{x.reason ? ` (${x.reason})` : ''}
              {typeof x.size === 'number' ? ` — ${Math.round(x.size/1024)}KB` : ''}
              {typeof x.originalSize === 'number' && x.status !== 'skip' && x.status !== 'error' ? ` (原始 ${Math.round(x.originalSize/1024)}KB)` : ''}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 12 }}>
        {outputUrl && (
          <a download={`processed_${Date.now()}.zip`} href={outputUrl}>下載處理後 ZIP</a>
        )}
      </div>
    </div>
  )
}
