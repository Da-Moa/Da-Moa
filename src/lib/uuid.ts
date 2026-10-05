export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uuidV7(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => byte.toString(16).padStart(2, '0')).join('')
  const time = Date.now().toString(16).padStart(12, '0')
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${(8 + (parseInt(random[3], 16) & 3)).toString(16)}${random.slice(4, 7)}-${random.slice(7, 19)}`
}
