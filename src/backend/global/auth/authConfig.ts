export function getSessionSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error('AUTH_JWT_SECRET must be at least 32 bytes');
  return secret;
}
