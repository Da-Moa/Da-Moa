export function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')
  if (!value) return undefined
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined
}

export function waitForRateLimit(seconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, seconds * 1000)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
