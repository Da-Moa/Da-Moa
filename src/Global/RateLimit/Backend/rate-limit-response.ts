export function rateLimitResponse(retryAfterSeconds: number) {
  return { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({
    error: 'rate_limited',
    message: `요청이 많아요. ${retryAfterSeconds}초 후 다시 시도해 주세요.`,
    details: { retryAfterSeconds },
  }) }
}
