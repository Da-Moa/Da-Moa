import { getSessionSecret } from './authConfig'
import { getKakaoRedirectUris, safeReturnTo } from '../../../shared/authUrls'
export { getKakaoRedirectUris, safeReturnTo } from '../../../shared/authUrls'
// Node crypto is also used by the native WebSocket server; client reachability is checked by domain-boundaries.test.ts.
import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

const OIDC_MAX_AGE_SECONDS = 10 * 60

export const OIDC_COOKIE_NAMES = {
  codeVerifier: 'da_moa_oidc_verifier',
  nonce: 'da_moa_oidc_nonce',
  redirectUri: 'da_moa_oidc_redirect_uri',
  state: 'da_moa_oidc_state',
} as const
export const ACCESS_TOKEN_COOKIE_NAME = 'da_moa_access'
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 10 * 60
export const REFRESH_TOKEN_COOKIE_NAME = 'da_moa_refresh'
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 14 * 24 * 60 * 60
export const ONBOARDING_MAX_AGE_SECONDS = 10 * 60
export const RETURN_TO_COOKIE_NAME = 'da_moa_return_to'

type JsonObject = Record<string, unknown>

export type KakaoConfig = {
  clientId: string
  clientSecret?: string
  redirectUri: string
}

export type KakaoProfile = {
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
}

export type AccessToken = {
  issuedAt: number
  sessionId: string
  userId: string
  purpose?: 'app' | 'onboarding'
  expiresAt?: number
}

export type RefreshToken = AccessToken

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function encodeJson(value: JsonObject): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeJson(value: string): JsonObject | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null

  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return isJsonObject(decoded) ? decoded : null
  } catch {
    return null
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function signHs256(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

export function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}


export function getKakaoConfig(origin?: URL | null, selectedRedirectUri?: string): KakaoConfig {
  const clientId = process.env.KAKAO_REST_API_KEY
    || process.env.KAKAO_CLIENT_ID
    || process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY
  const redirectUris = getKakaoRedirectUris()
  const redirectUri = selectedRedirectUri
    ? redirectUris.find(uri => uri === selectedRedirectUri && new URL(uri).origin === origin?.origin)
    : origin === undefined ? redirectUris[0] : redirectUris.find(uri => new URL(uri).origin === origin?.origin)

  if (!clientId || !redirectUri) throw new Error('Kakao OIDC is not configured')

  return {
    clientId,
    clientSecret: process.env.KAKAO_CLIENT_SECRET || undefined,
    redirectUri,
  }
}

export function getKakaoAuthenticationConfig(origin?: URL | null): KakaoConfig {
  const config = getKakaoConfig(origin)
  getSessionSecret()
  return config
}

export function authCookieOptions(maxAge: number, path = '/') {
  return {
    httpOnly: true,
    // Cookie policy takes seconds; Express cookie maxAge takes milliseconds.
    maxAge: maxAge * 1000,
    path,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  }
}

export function refreshCookieOptions(maxAge: number) {
  return authCookieOptions(maxAge, '/api/auth')
}

export function createReturnToCookie(
  value: unknown,
  state: string,
  secret = getSessionSecret(),
  now = currentTimestamp(),
) {
  const payload = encodeJson({ path: safeReturnTo(value), state, exp: now + ONBOARDING_MAX_AGE_SECONDS })
  return `${payload}.${signHs256(`return-to:${payload}`, secret)}`
}

export function createRedirectUriCookie(redirectUri: string, state: string, secret = getSessionSecret(), now = currentTimestamp()) {
  const payload = encodeJson({ redirectUri, state, exp: now + OIDC_MAX_AGE_SECONDS })
  return `${payload}.${signHs256(`redirect-uri:${payload}`, secret)}`
}

export function readRedirectUriCookie(token: string | undefined, expectedState: string, secret?: string, now = currentTimestamp()): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  let signature: string
  try { signature = signHs256(`redirect-uri:${parts[0]}`, secret ?? getSessionSecret()) } catch { return null }
  if (!safeEqual(parts[1], signature)) return null
  const payload = decodeJson(parts[0])
  if (!payload || !isTimestamp(payload.exp) || payload.exp <= now
      || payload.state !== expectedState || typeof payload.redirectUri !== 'string') return null
  return payload.redirectUri
}

export function readReturnToCookie(
  token: string | undefined,
  expectedState?: string,
  secret?: string,
  now = currentTimestamp(),
): string {
  if (!token) return '/home'
  const parts = token.split('.')
  let signature: string
  try { signature = signHs256(`return-to:${parts[0]}`, secret ?? getSessionSecret()) } catch { return '/home' }
  if (parts.length !== 2 || !safeEqual(parts[1], signature)) return '/home'
  const payload = decodeJson(parts[0])
  if (!payload || !isTimestamp(payload.exp) || payload.exp <= now
      || typeof payload.state !== 'string' || (expectedState !== undefined && payload.state !== expectedState)) return '/home'
  return safeReturnTo(payload.path)
}

export { OIDC_MAX_AGE_SECONDS }
