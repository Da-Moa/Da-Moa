'use client'

import { clearAccessToken, getAccessToken, setAccessToken } from '../Global/Auth/Frontend'
import { uuidV4 } from './uuid'
import { retryAfterSeconds, waitForRateLimit } from '../Global/Util/Frontend/rate-limit-util'

export class ApiError extends Error {
  recover?: () => Promise<unknown>
  retryAfterSeconds?: number
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

function responseError(response: Response, result: { error?: string; message?: string; details?: unknown } | null) {
  const seconds = response.status === 429 ? retryAfterSeconds(response) : undefined
  const error = new ApiError(response.status, result?.error ?? (response.status === 429 ? 'rate_limited' : 'request_failed'),
    seconds ? `요청이 많아요. ${seconds}초 후 다시 시도해 주세요.` : result?.message ?? '요청을 처리하지 못했어요. 다시 시도해 주세요.', result?.details)
  error.retryAfterSeconds = seconds
  return error
}

let refreshRequest: Promise<Response> | undefined
type PendingMutation = { signature: string; key: string; body: unknown; discarded?: boolean }
const unfinishedRequests = new Map<string, PendingMutation>()

export function discardPendingRequest(path: string, method: string) {
  const operation = `${method} ${path}`
  const pending = unfinishedRequests.get(operation)
  if (!pending) return
  pending.body = undefined
  pending.signature = ''
  pending.discarded = true
  unfinishedRequests.delete(operation)
}

function discardPendingRequests() {
  for (const operation of unfinishedRequests.keys()) {
    const separator = operation.indexOf(' ')
    discardPendingRequest(operation.slice(separator + 1), operation.slice(0, separator))
  }
}

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
    const bytes = await value.arrayBuffer()
    let hash: Uint8Array
    if (crypto.subtle) hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    else {
      // Web Crypto digest is unavailable on HTTP LAN origins. Reuse the SDK's pure JS SHA-256.
      const { Sha256Js } = await import('@smithy/core/checksum')
      const digest = new Sha256Js()
      digest.update(new Uint8Array(bytes))
      hash = await digest.digest()
    }
    return [key, value.type, Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')]
  }))
  return JSON.stringify([path, method, entries])
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal; response?: 'blob'; fresh?: boolean; createRequestKey?: () => string }
const readRequests = new Map<string, Promise<unknown>>()

export function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if ((options.method ?? 'GET') !== 'GET' || options.signal || options.fresh) return request<T>(path, options)
  const key = JSON.stringify([path, options.response, getAccessToken()])
  let pending = readRequests.get(key)
  if (!pending) {
    pending = request<T>(path, options).finally(() => { readRequests.delete(key) })
    readRequests.set(key, pending)
  }
  return pending as Promise<T>
}

async function request<T>(path: string, options: RequestOptions, retryRead = true): Promise<T> {
  const method = options.method ?? 'GET'
  const mutation = method !== 'GET'
  const operation = `${method} ${path}`
  const signature = mutation ? await fingerprint(path, method, options.body) : ''
  options.signal?.throwIfAborted()
  let pending: PendingMutation | undefined
  if (mutation) {
    pending = unfinishedRequests.get(operation)
    if (pending && pending.signature !== signature) {
      const previous = pending
      const error = new ApiError(409, 'unresolved_request', '이전 요청의 저장 결과를 먼저 확인해야 해요. 변경한 입력은 아직 저장되지 않았어요.')
      error.recover = () => {
        if (previous.discarded) return Promise.reject(new ApiError(409, 'request_discarded', '이전 입력을 지웠어요. 저장된 내용을 확인한 뒤 다시 입력해 주세요.'))
        return apiRequest(path, { method, body: previous.body })
      }
      throw error
    }
    pending ??= { signature, key: options.createRequestKey?.() ?? uuidV4(), body: snapshot(options.body) }
    unfinishedRequests.set(operation, pending)
  }
  const body = pending ? pending.body : options.body
  const multipart = body instanceof FormData
  const forget = () => { if (pending && unfinishedRequests.get(operation) === pending) discardPendingRequest(path, method) }
  const headers = new Headers()
  const accessToken = getAccessToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json')
  if (pending) headers.set('Idempotency-Key', pending.key)
  const init: RequestInit = {
    method, headers, cache: 'no-store', credentials: 'same-origin', signal: options.signal,
    body: multipart ? body as FormData : body === undefined ? undefined : JSON.stringify(body),
  }
  let response: Response
  try {
    response = await fetch(path, init)
    if ((response.status === 401 || path === '/api/me' && response.status === 404) && !path.startsWith('/api/auth/')) {
      refreshRequest ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        .then(async response => {
          if (response.ok) {
            const result = await response.clone().json()
            if (typeof result.data?.accessToken !== 'string') throw new ApiError(503, 'refresh_unavailable', '로그인 상태를 확인하지 못했어요. 다시 시도해 주세요.')
            setAccessToken(result.data.accessToken)
          }
          return response
        })
        .finally(() => { refreshRequest = undefined })
      const refresh = await refreshRequest
      if (refresh.ok) {
        headers.set('Authorization', `Bearer ${getAccessToken()}`)
        response = await fetch(path, init)
      }
      else if (refresh.status === 401) response = refresh
      else if (refresh.status === 429) throw responseError(refresh, await refresh.clone().json().catch(() => null))
      else throw new ApiError(refresh.status, 'storage_unavailable', '로그인 상태를 확인하지 못했어요. 입력을 유지했으니 다시 시도해 주세요.')
    }
  } catch (error) {
    if (error instanceof ApiError || error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(503, 'network_error', '연결을 확인해 주세요. 저장 여부를 확인하려면 같은 작업을 다시 시도해 주세요.')
  }
  if (response.ok && options.response === 'blob') return await response.blob() as T
  const result = await response.json().catch(() => null) as { data?: T; error?: string; message?: string; details?: unknown } | null
  if (response.status === 401) {
    clearAccessToken()
    discardPendingRequests()
    window.location.assign(`/login?returnTo=${encodeURIComponent(destination())}`)
    throw new ApiError(401, 'unauthorized', '로그인이 필요해요.')
  }
  if (response.status === 403 && result?.error === 'onboarding_required') {
    discardPendingRequests()
    window.location.assign(`/onboarding?returnTo=${encodeURIComponent(destination())}`)
  }
  if (!response.ok) {
    const error = responseError(response, result)
    if (response.status === 429 && method === 'GET' && retryRead && error.retryAfterSeconds) {
      await waitForRateLimit(error.retryAfterSeconds, options.signal)
      return request<T>(path, options, false)
    }
    if (response.status < 500 && response.status !== 429) forget()
    throw error
  }
  if (!result) throw new ApiError(503, 'response_unavailable', '처리 결과를 확인하지 못했어요. 같은 작업으로 다시 확인해 주세요.')
  const issuedToken = (result.data as { accessToken?: unknown } | undefined)?.accessToken
  if (typeof issuedToken === 'string') setAccessToken(issuedToken)
  if (path === '/api/auth/logout' || path === '/api/auth/withdraw') clearAccessToken()
  forget()
  return (result.data ?? result) as T
}
