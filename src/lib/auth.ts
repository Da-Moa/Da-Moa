import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto'

const APP_AUDIENCE = 'da-moa'
const APP_ISSUER = 'da-moa'
const CLOCK_SKEW_SECONDS = 60
const KAKAO_AUTHORIZATION_ENDPOINT = 'https://kauth.kakao.com/oauth/authorize'
const KAKAO_ISSUER = 'https://kauth.kakao.com'
const KAKAO_JWKS_URI = 'https://kauth.kakao.com/.well-known/jwks.json'
const KAKAO_TOKEN_ENDPOINT = 'https://kauth.kakao.com/oauth/token'
const KAKAO_OIDC_USERINFO_ENDPOINT = 'https://kapi.kakao.com/v1/oidc/userinfo'
const KAKAO_USER_INFO_ENDPOINT = 'https://kapi.kakao.com/v2/user/me'
const OIDC_MAX_AGE_SECONDS = 10 * 60

export const OIDC_COOKIE_NAMES = {
  codeVerifier: 'da_moa_oidc_verifier',
  nonce: 'da_moa_oidc_nonce',
  state: 'da_moa_oidc_state',
} as const
export const ACCESS_TOKEN_COOKIE_NAME = 'da_moa_access'
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 5 * 60
export const REFRESH_TOKEN_COOKIE_NAME = 'da_moa_refresh'
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 14 * 24 * 60 * 60

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
}

export type RefreshToken = AccessToken

type TokenType = 'access' | 'refresh'

type TokenPayload = {
  aud: string
  exp: number
  iat: number
  iss: string
  sid: string
  sub: string
  token_type: TokenType
}

type ParsedJwt = {
  header: JsonObject
  payload: JsonObject
  signature: string
  signingInput: string
}

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

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [encodedHeader, encodedPayload, signature] = parts
  if (!encodedHeader || !encodedPayload || !signature || !/^[A-Za-z0-9_-]+$/.test(signature)) return null

  const header = decodeJson(encodedHeader)
  const payload = decodeJson(encodedPayload)
  if (!header || !payload) return null

  return { header, payload, signature, signingInput: `${encodedHeader}.${encodedPayload}` }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

function httpsUrl(value: unknown): string | null {
  const text = optionalText(value)
  if (!text) return null

  try {
    const url = new URL(text)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function signHs256(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

export function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function getSessionSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 bytes')
  }
  return secret
}

export function getKakaoConfig(): KakaoConfig {
  const clientId = process.env.KAKAO_REST_API_KEY
    || process.env.KAKAO_CLIENT_ID
    || process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY
  const redirectUri = process.env.KAKAO_REDIRECT_URI || process.env.NEXT_PUBLIC_KAKAO_REDIRECT_URI

  if (!clientId || !redirectUri) throw new Error('Kakao OIDC is not configured')

  return {
    clientId,
    clientSecret: process.env.KAKAO_CLIENT_SECRET || undefined,
    redirectUri,
  }
}

export function getKakaoAuthenticationConfig(): KakaoConfig {
  const config = getKakaoConfig()
  getSessionSecret()
  return config
}

export function authCookieOptions(maxAge: number, path = '/') {
  return {
    httpOnly: true,
    maxAge,
    path,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  }
}

export function refreshCookieOptions(maxAge: number) {
  return authCookieOptions(maxAge, '/api/auth')
}

export function createKakaoAuthorizationRequest(config: KakaoConfig) {
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const codeVerifier = randomBytes(64).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const authorizationUrl = new URL(KAKAO_AUTHORIZATION_ENDPOINT)

  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid,profile_nickname,profile_image,account_email',
    state,
  }).toString()

  return { codeVerifier, nonce, state, url: authorizationUrl.toString() }
}

export async function exchangeKakaoAuthorizationCode(
  config: KakaoConfig,
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; idToken: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const response = await fetch(KAKAO_TOKEN_ENDPOINT, {
    body,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const result: unknown = await response.json().catch(() => null)

  if (
    !response.ok
    || !isJsonObject(result)
    || typeof result.access_token !== 'string'
    || typeof result.id_token !== 'string'
  ) {
    throw new Error('Kakao token exchange failed')
  }

  return { accessToken: result.access_token, idToken: result.id_token }
}

function isKakaoSigningKey(candidate: unknown, kid: string): candidate is NodeJsonWebKey {
  return (
    isJsonObject(candidate)
    && candidate.kid === kid
    && candidate.kty === 'RSA'
    && candidate.alg === 'RS256'
    && candidate.use === 'sig'
    && typeof candidate.n === 'string'
    && typeof candidate.e === 'string'
  )
}

async function fetchKakaoJwks(bypassCache = false): Promise<unknown[] | null> {
  const response = await fetch(KAKAO_JWKS_URI, {
    ...(bypassCache ? { cache: 'no-store' as const } : { next: { revalidate: 300 } }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const jwks: unknown = await response.json().catch(() => null)
  return response.ok && isJsonObject(jwks) && Array.isArray(jwks.keys) ? jwks.keys : null
}

export async function verifyKakaoIdToken(
  token: string,
  config: KakaoConfig,
  expectedNonce: string,
): Promise<string | null> {
  const parsed = parseJwt(token)
  const kid = parsed?.header.kid
  if (
    !parsed
    || parsed.header.alg !== 'RS256'
    || typeof kid !== 'string'
  ) return null

  let jwks = await fetchKakaoJwks()
  if (!jwks) return null

  let key = jwks.find((candidate): candidate is NodeJsonWebKey => (
    isKakaoSigningKey(candidate, kid)
  ))
  const cachedKidExists = jwks.some((candidate) => (
    isJsonObject(candidate) && candidate.kid === kid
  ))

  if (!key && !cachedKidExists) {
    jwks = await fetchKakaoJwks(true)
    if (!jwks) return null
    key = jwks.find((candidate): candidate is NodeJsonWebKey => (
      isKakaoSigningKey(candidate, kid)
    ))
  }
  if (!key) return null

  try {
    const publicKey = createPublicKey({ format: 'jwk', key })
    const valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(parsed.signingInput),
      publicKey,
      Buffer.from(parsed.signature, 'base64url'),
    )
    if (!valid) return null
  } catch {
    return null
  }

  const { aud, azp, exp, iat, iss, nonce, sub } = parsed.payload
  const audiences = typeof aud === 'string'
    ? [aud]
    : Array.isArray(aud) && aud.every((value) => typeof value === 'string')
      ? aud
      : []
  const now = currentTimestamp()

  if (
    iss !== KAKAO_ISSUER
    || !audiences.includes(config.clientId)
    || (audiences.length > 1 && azp !== config.clientId)
    || !isTimestamp(exp)
    || exp <= now - CLOCK_SKEW_SECONDS
    || !isTimestamp(iat)
    || iat > now + CLOCK_SKEW_SECONDS
    || typeof nonce !== 'string'
    || !safeEqual(nonce, expectedNonce)
    || typeof sub !== 'string'
    || !sub
  ) return null

  return sub
}

export async function getKakaoUserProfile(
  accessToken: string,
  expectedSubject: string,
): Promise<KakaoProfile> {
  const oidcResponse = await fetch(KAKAO_OIDC_USERINFO_ENDPOINT, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${accessToken}` },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const oidcUserInfo: unknown = await oidcResponse.json().catch(() => null)

  if (
    !oidcResponse.ok
    || !isJsonObject(oidcUserInfo)
    || typeof oidcUserInfo.sub !== 'string'
    || !safeEqual(oidcUserInfo.sub, expectedSubject)
  ) {
    throw new Error('Kakao user info request failed')
  }

  const userInfoUrl = new URL(KAKAO_USER_INFO_ENDPOINT)
  userInfoUrl.searchParams.set('secure_resource', 'true')
  const response = await fetch(userInfoUrl, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${accessToken}` },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok || !isJsonObject(result)) throw new Error('Kakao profile request failed')

  const kakaoAccount = isJsonObject(result.kakao_account) ? result.kakao_account : null
  const profile = kakaoAccount && isJsonObject(kakaoAccount.profile) ? kakaoAccount.profile : null

  return {
    displayName: optionalText(profile?.nickname) ?? optionalText(oidcUserInfo.nickname),
    email: kakaoAccount?.is_email_valid === true && kakaoAccount.is_email_verified === true
      ? optionalText(kakaoAccount.email)
      : oidcUserInfo.email_verified === true ? optionalText(oidcUserInfo.email) : null,
    profileImageUrl: httpsUrl(profile?.profile_image_url)
      ?? httpsUrl(profile?.thumbnail_image_url)
      ?? httpsUrl(oidcUserInfo.picture),
  }
}

function createToken(
  tokenType: TokenType,
  userId: string,
  sessionId: string,
  maxAge: number,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
): string {
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' })
  const payload: TokenPayload = {
    aud: APP_AUDIENCE,
    exp: issuedAt + maxAge,
    iat: issuedAt,
    iss: APP_ISSUER,
    sid: sessionId,
    sub: userId,
    token_type: tokenType,
  }
  const encodedPayload = encodeJson(payload)
  const signingInput = `${header}.${encodedPayload}`
  return `${signingInput}.${signHs256(signingInput, secret)}`
}

function verifyToken(
  tokenType: TokenType,
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
): AccessToken | null {
  if (!token) return null

  const parsed = parseJwt(token)
  if (
    !parsed
    || parsed.header.alg !== 'HS256'
    || parsed.header.typ !== 'JWT'
    || !safeEqual(parsed.signature, signHs256(parsed.signingInput, secret))
  ) return null

  const { aud, exp, iat, iss, sid, sub, token_type: payloadTokenType } = parsed.payload
  if (
    aud !== APP_AUDIENCE
    || iss !== APP_ISSUER
    || payloadTokenType !== tokenType
    || typeof sub !== 'string'
    || !sub
    || typeof sid !== 'string'
    || !sid
    || !isTimestamp(exp)
    || exp <= now
    || !isTimestamp(iat)
    || iat > now + CLOCK_SKEW_SECONDS
  ) return null

  return { issuedAt: iat, sessionId: sid, userId: sub }
}

export function createAccessToken(
  userId: string,
  sessionId: string,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
) {
  return createToken('access', userId, sessionId, ACCESS_TOKEN_MAX_AGE_SECONDS, secret, issuedAt)
}

export function createRefreshToken(
  userId: string,
  sessionId: string,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
) {
  return createToken('refresh', userId, sessionId, REFRESH_TOKEN_MAX_AGE_SECONDS, secret, issuedAt)
}

export function verifyAccessToken(
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
) {
  return verifyToken('access', token, secret, now)
}

export function verifyRefreshToken(
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
) {
  return verifyToken('refresh', token, secret, now)
}

export function readAccessToken(token: string | undefined): AccessToken | null {
  try {
    return verifyAccessToken(token)
  } catch {
    return null
  }
}

export function readRefreshToken(token: string | undefined): RefreshToken | null {
  try {
    return verifyRefreshToken(token)
  } catch {
    return null
  }
}

export function hashRefreshToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export { OIDC_MAX_AGE_SECONDS }
