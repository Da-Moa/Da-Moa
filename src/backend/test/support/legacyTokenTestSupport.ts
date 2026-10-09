// Historical app JWT codec: test-only fixtures prove rolling-token compatibility.
// Production signing and verification belong to the injected TokenService.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSessionSecret } from '../../global/auth/authConfig';
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  currentTimestamp,
  type AccessToken,
  type RefreshToken,
} from '../../global/auth/authUtil';
const APP_AUDIENCE = 'da-moa';
const APP_ISSUER = 'da-moa';
const CLOCK_SKEW_SECONDS = 60;
type JsonObject = Record<string, unknown>;
type TokenType = 'access' | 'refresh';

type TokenPayload = {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  sid: string;
  sub: string;
  token_type: TokenType;
  purpose?: 'app' | 'onboarding';
};

type ParsedJwt = {
  header: JsonObject;
  payload: JsonObject;
  signature: string;
  signingInput: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function encodeJson(value: JsonObject): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value: string): JsonObject | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    return isJsonObject(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (
    !encodedHeader ||
    !encodedPayload ||
    !signature ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  )
    return null;

  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!header || !payload) return null;

  return {
    header,
    payload,
    signature,
    signingInput: `${encodedHeader}.${encodedPayload}`,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function signHs256(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function createToken(
  tokenType: TokenType,
  userId: string,
  sessionId: string,
  maxAge: number,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
  purpose?: 'app' | 'onboarding',
): string {
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload: TokenPayload = {
    aud: APP_AUDIENCE,
    exp: issuedAt + maxAge,
    iat: issuedAt,
    iss: APP_ISSUER,
    sid: sessionId,
    sub: userId,
    token_type: tokenType,
    ...(purpose ? { purpose } : {}),
  };
  const encodedPayload = encodeJson(payload);
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${signHs256(signingInput, secret)}`;
}

function verifyToken(
  tokenType: TokenType,
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
): AccessToken | null {
  if (!token) return null;

  const parsed = parseJwt(token);
  if (
    !parsed ||
    parsed.header.alg !== 'HS256' ||
    parsed.header.typ !== 'JWT' ||
    !safeEqual(parsed.signature, signHs256(parsed.signingInput, secret))
  )
    return null;

  const {
    aud,
    exp,
    iat,
    iss,
    sid,
    sub,
    token_type: payloadTokenType,
    purpose,
  } = parsed.payload;
  if (
    aud !== APP_AUDIENCE ||
    iss !== APP_ISSUER ||
    payloadTokenType !== tokenType ||
    (purpose !== undefined && purpose !== 'app' && purpose !== 'onboarding') ||
    typeof sub !== 'string' ||
    !sub ||
    typeof sid !== 'string' ||
    !sid ||
    !isTimestamp(exp) ||
    exp <= now ||
    !isTimestamp(iat) ||
    iat > now + CLOCK_SKEW_SECONDS
  )
    return null;

  return {
    issuedAt: iat,
    sessionId: sid,
    userId: sub,
    ...(purpose ? { purpose } : {}),
    ...(tokenType === 'refresh' ? { expiresAt: exp } : {}),
  };
}

export function createAccessToken(
  userId: string,
  sessionId: string,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
  maxAge = ACCESS_TOKEN_MAX_AGE_SECONDS,
  purpose?: 'app' | 'onboarding',
) {
  return createToken(
    'access',
    userId,
    sessionId,
    maxAge,
    secret,
    issuedAt,
    purpose,
  );
}

export function createRefreshToken(
  userId: string,
  sessionId: string,
  secret = getSessionSecret(),
  issuedAt = currentTimestamp(),
  maxAge = REFRESH_TOKEN_MAX_AGE_SECONDS,
  purpose?: 'app' | 'onboarding',
) {
  return createToken(
    'refresh',
    userId,
    sessionId,
    maxAge,
    secret,
    issuedAt,
    purpose,
  );
}

export function verifyAccessToken(
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
) {
  return verifyToken('access', token, secret, now);
}

export function verifyRefreshToken(
  token: string | undefined,
  secret = getSessionSecret(),
  now = currentTimestamp(),
) {
  return verifyToken('refresh', token, secret, now);
}

export function readAccessToken(token: string | undefined): AccessToken | null {
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export function readRefreshToken(
  token: string | undefined,
): RefreshToken | null {
  try {
    return verifyRefreshToken(token);
  } catch {
    return null;
  }
}
