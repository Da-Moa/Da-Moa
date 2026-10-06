import createEncoder from '@jsquash/avif/codec/enc/avif_enc.js'
import { defaultOptions } from '@jsquash/avif/meta.js'
import { MAX_RECEIPT_BYTES, RECEIPT_MAX_EDGE } from '../Shared/receipt'

self.onmessage = async (event: MessageEvent<File>) => {
  let image: ImageBitmap | undefined
  try {
    image = await createImageBitmap(event.data, { imageOrientation: 'from-image' })
    const scale = Math.min(1, RECEIPT_MAX_EDGE / Math.max(image.width, image.height))
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('이미지를 처리할 수 없어요')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    image.close(); image = undefined
    // Use one WASM encoder thread per upload, including cross-origin isolated pages.
    const encoder = await createEncoder()
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const result = encoder.encode(pixels.data, canvas.width, canvas.height, { ...defaultOptions, quality: 80, speed: 8, subsample: 3 })
    if (!result) throw new Error('이미지를 AVIF로 변환하지 못했어요')
    const content = new Uint8Array(result).buffer
    if (content.byteLength > MAX_RECEIPT_BYTES) throw new Error('변환한 영수증 파일은 10MB 이하로 올려 주세요')
    self.postMessage({ content }, { transfer: [content] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '이미지를 AVIF로 변환하지 못했어요' })
  } finally { image?.close() }
}
