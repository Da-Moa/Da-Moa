import { randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  type RefreshToken,
} from '../authUtil';

export type AuthSession = {
  userId: string;
  purpose: 'app' | 'onboarding';
  accessToken: string;
  refreshToken: string;
  accessMaxAge: number;
  refreshMaxAge: number;
};

export function issueTokens(
  userId: string,
  purpose: 'app' | 'onboarding',
  now: number,
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
  const refreshToken = createRefreshToken(
    userId,
    sessionId,
    undefined,
    now,
    refreshMaxAge,
    purpose,
  );
  const accessToken = createAccessToken(
    userId,
    sessionId,
    undefined,
    now,
    accessMaxAge,
    purpose,
  );
  return {
    userId,
    purpose,
    accessToken,
    refreshToken,
    accessMaxAge,
    refreshMaxAge,
  };
}

// The single statement returns either the existing account state or the new user.

export function refreshTokens(refresh: RefreshToken) {
  const now = currentTimestamp(),
    purpose = refresh.purpose ?? 'app';
  const remaining = (refresh.expiresAt ?? now) - now;
  const refreshMaxAge =
    purpose === 'onboarding' ? remaining : REFRESH_TOKEN_MAX_AGE_SECONDS;
  const accessMaxAge = Math.min(ACCESS_TOKEN_MAX_AGE_SECONDS, remaining);
  return {
    accessToken: createAccessToken(
      refresh.userId,
      refresh.sessionId,
      undefined,
      now,
      accessMaxAge,
      purpose,
    ),
    refreshToken: createRefreshToken(
      refresh.userId,
      refresh.sessionId,
      undefined,
      now,
      refreshMaxAge,
      purpose,
    ),
    refreshMaxAge,
  };
}
