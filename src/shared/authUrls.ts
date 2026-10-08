export function getKakaoRedirectUris(): string[] {
  const configured = process.env.KAKAO_REDIRECT_URI || process.env.NEXT_PUBLIC_KAKAO_REDIRECT_URI || ''
  const uris = [...new Set(configured.split(',').map(uri => uri.trim()).filter(Boolean))]
  for (const uri of uris) {
    const url = new URL(uri)
    if (!/^https?:\/\//.test(uri) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid Kakao redirect URI')
    }
  }
  return uris
}


export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) return '/home'
  // Only literal local paths are accepted; encoded separators and redirect loops cannot pass.
  return /^(?:\/home(?:\/[A-Za-z0-9_-]+)*|\/(?:invites|settlements)\/[A-Za-z0-9_-]+)$/.test(value)
    ? value : '/home'
}
