export function uuidV7(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => byte.toString(16).padStart(2, '0')).join('')
  const time = Date.now().toString(16).padStart(12, '0')
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${(8 + (parseInt(random[3], 16) & 3)).toString(16)}${random.slice(4, 7)}-${random.slice(7, 19)}`
}
