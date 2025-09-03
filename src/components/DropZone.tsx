import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'

type Props = { onFile: (file: File) => void }

export default function DropZone({ onFile }: Props) {
  const onDrop = useCallback((accepted: File[]) => {
    console.log(accepted, ":onDrop[accepted]")
    if (accepted[0]) onFile(accepted[0])
  }, [onFile])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    multiple: false,
    accept: { 'application/zip': ['.zip'] },
    onDrop,
  })

  return (
    <div {...getRootProps()} style={{ padding: 24, border: '2px dashed #999', borderRadius: 12, textAlign: 'center' }}>
      <input {...getInputProps()} />
      {isDragActive ? '放開上傳 ZIP' : '拖拉 ZIP 到此或點擊選擇 ZIP'}
    </div>
  )
}
