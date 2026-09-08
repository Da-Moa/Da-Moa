'use client'

export class ApiError extends Error {
  recover?: () => Promise<unknown>
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

let refreshRequest: Promise<Response> | undefined
type PendingMutation = { signature: string; key: string; body: unknown }
const unfinishedRequests = new Map<string, PendingMutation>()

function snapshot(body: unknown): unknown {
  if (body instanceof FormData) {
    const copy = new FormData()
    for (const [key, value] of body.entries()) copy.append(key, value)
    return copy
  }
  return body === undefined ? undefined : structuredClone(body)
}

function destination() {
  const current = `${window.location.pathname}${window.location.search}`
  if (!current.startsWith('/onboarding')) return current
  const returnTo = new URLSearchParams(window.location.search).get('returnTo') ?? '/home'
  return /^\/(home(?:\/|$)|invites\/|settlements\/)/.test(returnTo) && !/[\\%]/.test(returnTo) ? returnTo : '/home'
}

async function fingerprint(path: string, method: string, body: unknown): Promise<string> {
  // A refreshed version must not turn an unacknowledged write into a second write.
  if (!(body instanceof FormData)) {
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'expectedVersion').sort(([a], [b]) => a.localeCompare(b))) : body
    return JSON.stringify([path, method, fields])
  }
  const entries = await Promise.all(Array.from(body.entries()).filter(([key]) => key !== 'expectedVersion').sort(([a], [b]) => a.localeCompare(b)).map(async ([key, value]) => {
    if (typeof value === 'string') return [key, value]
    const hash = await crypto.subtle.digest('SHA-256', await value.arrayBuffer())
    return [key, value.type, Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')]
  }))
  return JSON.stringify([path, method, entries])
}

export async function apiRequest<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; response?: 'blob' } = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const mutation = method !== 'GET'
  const operation = `${method} ${path}`
  const signature = mutation ? await fingerprint(path, method, options.body) : ''
  let pending: PendingMutation | undefined
  if (mutation) {
    pending = unfinishedRequests.get(operation)
    if (pending && pending.signature !== signature) {
      const previous = pending
      const error = new ApiError(409, 'unresolved_request', '이전 요청의 저장 결과를 먼저 확인해야 해요. 변경한 입력은 아직 저장되지 않았어요.')
      error.recover = () => apiRequest(path, { method, body: previous.body })
      throw error
    }
    pending ??= { signature, key: crypto.randomUUID(), body: snapshot(options.body) }
    unfinishedRequests.set(operation, pending)
  }
  const body = pending ? pending.body : options.body
  const multipart = body instanceof FormData
  const forget = () => { if (pending && unfinishedRequests.get(operation) === pending) unfinishedRequests.delete(operation) }
  const headers = new Headers()
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json')
  if (pending) headers.set('Idempotency-Key', pending.key)
  const init: RequestInit = {
    method, headers, cache: 'no-store', credentials: 'same-origin', signal: options.signal,
    body: multipart ? body as FormData : body === undefined ? undefined : JSON.stringify(body),
  }
  let response: Response
  try {
    response = await fetch(path, init)
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      refreshRequest ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        .finally(() => { refreshRequest = undefined })
      const refresh = await refreshRequest
      if (refresh.ok) response = await fetch(path, init)
      else if (refresh.status !== 401) throw new ApiError(refresh.status, 'storage_unavailable', '로그인 상태를 확인하지 못했어요. 입력을 유지했으니 다시 시도해 주세요.')
    }
  } catch (error) {
    if (error instanceof ApiError || error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(503, 'network_error', '연결을 확인해 주세요. 저장 여부를 확인하려면 같은 작업을 다시 시도해 주세요.')
  }
  if (response.ok && options.response === 'blob') return await response.blob() as T
  const result = await response.json().catch(() => null) as { data?: T; error?: string; message?: string; details?: unknown } | null
  if (response.status === 401) {
    window.location.assign(`/login?returnTo=${encodeURIComponent(destination())}`)
    throw new ApiError(401, 'unauthorized', '로그인이 필요해요.')
  }
  if (response.status === 403 && result?.error === 'onboarding_required') {
    window.location.assign(`/onboarding?returnTo=${encodeURIComponent(destination())}`)
  }
  if (!response.ok) {
    if (response.status < 500) forget()
    throw new ApiError(response.status, result?.error ?? 'request_failed', result?.message ?? '요청을 처리하지 못했어요. 다시 시도해 주세요.', result?.details)
  }
  if (!result) throw new ApiError(503, 'response_unavailable', '처리 결과를 확인하지 못했어요. 같은 작업으로 다시 확인해 주세요.')
  forget()
  return (result.data ?? result) as T
}
