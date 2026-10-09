import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  currentTimestamp,
  type AccessToken,
  type RefreshToken,
} from '../authUtil';
import type { AuthSession } from './authTokens';

type TokenType = 'access' | 'refresh';
type Purpose = 'app' | 'onboarding';
type VerifiedToken = {
  header: { alg: string; typ?: string };
  payload: Record<string, unknown> | string;
};
const audience = 'da-moa';
const issuer = 'da-moa';
const clockSkewSeconds = 60;
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

@Injectable()
export class TokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  private sign(
    tokenType: TokenType,
    userId: string,
    sessionId: string,
    issuedAt: number,
    maxAge: number,
    purpose?: Purpose,
  ) {
    return this.jwt.sign(
      {
        iat: issuedAt,
        sid: sessionId,
        sub: userId,
        token_type: tokenType,
        ...(purpose ? { purpose } : {}),
      },
      { algorithm: 'HS256', audience, issuer, expiresIn: maxAge },
    );
  }

  createAccessToken(
    userId: string,
    sessionId: string,
    issuedAt = currentTimestamp(),
    maxAge = ACCESS_TOKEN_MAX_AGE_SECONDS,
    purpose?: Purpose,
  ) {
    return this.sign('access', userId, sessionId, issuedAt, maxAge, purpose);
  }

  createRefreshToken(
    userId: string,
    sessionId: string,
    issuedAt = currentTimestamp(),
    maxAge = REFRESH_TOKEN_MAX_AGE_SECONDS,
    purpose?: Purpose,
  ) {
    return this.sign('refresh', userId, sessionId, issuedAt, maxAge, purpose);
  }

  private verify(
    tokenType: TokenType,
    token: string | undefined,
    now: number,
  ): AccessToken | null {
    if (!token) return null;
    try {
      const decoded = this.jwt.verify<VerifiedToken>(token, {
        algorithms: ['HS256'],
        audience,
        issuer,
        complete: true,
        clockTimestamp: now,
        // Existing app tokens do not use nbf. Preserve that policy while
        // expiration remains strict and future iat retains the 60-second bound.
        ignoreNotBefore: true,
      });
      if (
        decoded.header.typ !== 'JWT' ||
        typeof decoded.payload !== 'object' ||
        decoded.payload === null
      )
        return null;
      const { aud, exp, iat, iss, sid, sub, token_type, purpose } =
        decoded.payload;
      if (
        aud !== audience ||
        iss !== issuer ||
        token_type !== tokenType ||
        (purpose !== undefined &&
          purpose !== 'app' &&
          purpose !== 'onboarding') ||
        typeof sub !== 'string' ||
        !sub ||
        typeof sid !== 'string' ||
        !sid ||
        !timestamp(exp) ||
        exp <= now ||
        !timestamp(iat) ||
        iat > now + clockSkewSeconds
      )
        return null;
      return {
        issuedAt: iat,
        sessionId: sid,
        userId: sub,
        ...(purpose ? { purpose } : {}),
        ...(tokenType === 'refresh' ? { expiresAt: exp } : {}),
      };
    } catch {
      return null;
    }
  }

  verifyAccessToken(token: string | undefined, now = currentTimestamp()) {
    return this.verify('access', token, now);
  }

  verifyRefreshToken(token: string | undefined, now = currentTimestamp()) {
    return this.verify('refresh', token, now);
  }

  issueTokens(
    userId: string,
    purpose: Purpose,
    now = currentTimestamp(),
  ): AuthSession {
    const sessionId = randomUUID();
    const accessMaxAge =
      purpose === 'onboarding'
        ? ONBOARDING_MAX_AGE_SECONDS
        : ACCESS_TOKEN_MAX_AGE_SECONDS;
    const refreshMaxAge =
      purpose === 'onboarding'
        ? ONBOARDING_MAX_AGE_SECONDS
        : REFRESH_TOKEN_MAX_AGE_SECONDS;
    return {
      userId,
      purpose,
      accessMaxAge,
      refreshMaxAge,
      accessToken: this.createAccessToken(
        userId,
        sessionId,
        now,
        accessMaxAge,
        purpose,
      ),
      refreshToken: this.createRefreshToken(
        userId,
        sessionId,
        now,
        refreshMaxAge,
        purpose,
      ),
    };
  }

  accessTokenForRefresh(refresh: RefreshToken) {
    const now = currentTimestamp();
    const purpose = refresh.purpose ?? 'app';
    const maxAge = Math.min(
      ACCESS_TOKEN_MAX_AGE_SECONDS,
      (refresh.expiresAt ?? now) - now,
    );
    return {
      accessToken: this.createAccessToken(
        refresh.userId,
        refresh.sessionId,
        now,
        maxAge,
        purpose,
      ),
      purpose,
    };
  }

  refreshTokens(refresh: RefreshToken) {
    const now = currentTimestamp();
    const purpose = refresh.purpose ?? 'app';
    const remaining = (refresh.expiresAt ?? now) - now;
    const refreshMaxAge =
      purpose === 'onboarding' ? remaining : REFRESH_TOKEN_MAX_AGE_SECONDS;
    const accessMaxAge = Math.min(ACCESS_TOKEN_MAX_AGE_SECONDS, remaining);
    return {
      accessToken: this.createAccessToken(
        refresh.userId,
        refresh.sessionId,
        now,
        accessMaxAge,
        purpose,
      ),
      refreshToken: this.createRefreshToken(
        refresh.userId,
        refresh.sessionId,
        now,
        refreshMaxAge,
        purpose,
      ),
      refreshMaxAge,
    };
  }
}
