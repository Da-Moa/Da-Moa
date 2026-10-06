export function encodeReceipt(file: File): Promise<File> {
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) {
    return Promise.reject(new Error('JPEG·PNG·WebP 이미지만 올릴 수 있어요.'))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ReceiptEncoder.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ content?: ArrayBuffer; error?: string }>) => {
      worker.terminate()
      if (event.data.content) resolve(new File([event.data.content], `${file.name.replace(/\.[^.]+$/, '')}.avif`, { type: 'image/avif', lastModified: file.lastModified }))
      else reject(new Error(event.data.error ?? '이미지를 AVIF로 변환하지 못했어요'))
    }
    worker.onerror = () => { worker.terminate(); reject(new Error('이미지를 AVIF로 변환하지 못했어요. 다시 시도해 주세요')) }
    worker.postMessage(file)
  })
}
