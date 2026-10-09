import { getKakaoRedirectUris } from '../../auth/native.ts'
import { createWebsocketUtil } from '../websocketUtil.mjs'

export function createWsController(rateLimit, authenticate, publisher) {
  const websocket = createWebsocketUtil()
  const unregister = publisher.registerInvalidationPublisher((userId, keys) => {
    websocket.publish(`user:${userId}`, { type: 'invalidate', keys })
  })

  function handleUpgrade(request, socket, head) {
    if (request.url !== '/realtime') return
    const origin = request.headers.origin
    const host = request.headers.host
    let allowed = false
    try {
      const source = new URL(origin)
      const target = new URL(`${source.protocol}//${host}`)
      const publicOrigins = process.env.NODE_ENV === 'production' ? getKakaoRedirectUris().map(uri => new URL(uri).origin) : null
      allowed = ['http:', 'https:'].includes(source.protocol) && source.origin === target.origin
        && !source.username && !source.password && source.pathname === '/' && !source.search && !source.hash
        && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash
        && (!publicOrigins || publicOrigins.includes(source.origin))
    } catch { /* Invalid Origin or Host. */ }
    if (!allowed) { socket.destroy(); return }
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) ?? []
    const token = protocols.length === 2 && protocols[0] === 'da-moa' ? protocols[1] : null
    if (rateLimit.limitWebsocket(token, socket)) return
    void authenticate(token).then(auth => {
      if (!auth.id || socket.destroyed) { socket.destroy(); return }
      const userId = auth.id
      websocket.upgrade(request, socket, head, connection => {
        websocket.subscribe(`user:${userId}`, connection)
        let authTimer
        const revalidate = async () => {
          try {
            const current = await authenticate(token)
            if (connection.readyState !== connection.OPEN) return
            // A short-lived Access JWT must refresh through the browser before reconnecting.
            if (current.status === 401) connection.close(4001)
            else if (current.id !== userId) connection.close(1008)
            else authTimer = setTimeout(revalidate, 60000)
          } catch { if (connection.readyState === connection.OPEN) connection.close(1011) }
        }
        authTimer = setTimeout(revalidate, Math.random() * 60000)
        connection.on('close', () => clearTimeout(authTimer))
      })
    }).catch(() => socket.destroy())
  }
  function close() {
    unregister()
    return websocket.close()
  }
  return { handleUpgrade, close }
}
