import { getKakaoRedirectUris } from '../auth/native';
import type { Request as ExpressRequest } from 'express';

export function requestOrigin(request: Request): URL | null {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const protocol =
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ||
    new URL(request.url).protocol.slice(0, -1);
  return allowedOrigin(host, protocol);
}

function allowedOrigin(host: string, protocol: string): URL | null {
  if (!host || !['http', 'https'].includes(protocol)) return null;
  try {
    const origin = new URL(`${protocol}://${host}`);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return null;
    if (
      process.env.NODE_ENV === 'production' &&
      !getKakaoRedirectUris().some(
        (uri) => new URL(uri).origin === origin.origin,
      )
    )
      return null;
    return origin;
  } catch {
    return null;
  }
}

export function sameOrigin(request: Request): boolean {
  const expected = requestOrigin(request);
  return Boolean(expected && request.headers.get('origin') === expected.origin);
}

export function sameNodeOrigin(request: ExpressRequest): boolean {
  const expected = nodeRequestOrigin(request);
  return Boolean(expected && request.headers.origin === expected.origin);
}

export function nodeRequestOrigin(request: ExpressRequest): URL | null {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    request.protocol;
  return allowedOrigin(request.headers.host || 'localhost', protocol);
}
