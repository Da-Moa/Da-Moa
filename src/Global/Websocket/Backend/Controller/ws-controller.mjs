import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readAccessToken } from '../../../../lib/auth.ts'
import { getDatabasePool } from '../../../../lib/db-client.mjs'
import { createWebsocketUtil } from '../websocket-util.mjs'

export function createWsController(port) {
  process.env.REALTIME_INTERNAL_PORT = String(port)
  process.env.REALTIME_INTERNAL_SECRET = randomBytes(32).toString('hex')
  const websocket = createWebsocketUtil()
  function handleRequest(request, response) {
    if (request.url !== '/internal/realtime') return false
    if (request.method !== 'POST' || request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1' && request.socket.remoteAddress !== '::1') {
      response.writeHead(403).end(); return true
    }
    const received = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(process.env.REALTIME_INTERNAL_SECRET)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.writeHead(403).end(); return true }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 1048576) request.destroy() })
    request.on('end', () => {
      try {
        const targets = JSON.parse(body)
        if (!Array.isArray(targets) || targets.length > 10000 || !targets.every(target =>
          typeof target.userId === 'string' && /^[\w-]{1,128}$/.test(target.userId)
          && Array.isArray(target.keys) && target.keys.length > 0 && target.keys.length <= 20
          && target.keys.every(key => typeof key === 'string' && /^(me|groups|rounds|settlements|(group|group-rounds|round|settlement):[\w-]{1,128})$/.test(key)))) throw new Error('Invalid invalidation')
        for (const { userId, keys } of targets) websocket.publish(`user:${userId}`, { type: 'invalidate', keys })
        response.writeHead(204).end()
      } catch { response.writeHead(400).end() }
    })
    return true
  }

  async function authenticatedUser(token) {
    const access = readAccessToken(token ?? undefined)
    if (!access) return { status: 401 }
    if ((access.purpose ?? 'app') !== 'app') return { status: 403 }
    const database = process.env.DATABASE_URL || process.env.POSTGRES_URL
    if (!database) throw new Error('DATABASE_URL is required')
    const { rows: [account] } = await getDatabasePool(database).query({
      text: 'SELECT id, deleted_at, onboarding_completed_at FROM users WHERE id = $1',
      values: [access.userId], query_timeout: 10000,
    })
    if (!account || account.deleted_at !== null) return { status: 401 }
    return account.onboarding_completed_at !== null ? { status: 200, id: account.id } : { status: 403 }
  }

  function handleUpgrade(request, socket, head) {
    if (request.url !== '/realtime') return
    const origin = request.headers.origin
    const host = request.headers.host
    let allowed = false
    try {
      const source = new URL(origin)
      const target = new URL(`${source.protocol}//${host}`)
      const publicOrigin = process.env.NODE_ENV === 'production' ? new URL(process.env.KAKAO_REDIRECT_URI).origin : null
      allowed = ['http:', 'https:'].includes(source.protocol) && source.origin === target.origin
        && !source.username && !source.password && source.pathname === '/' && !source.search && !source.hash
        && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash
        && (!publicOrigin || source.origin === publicOrigin)
    } catch { /* Invalid Origin or Host. */ }
    if (!allowed) { socket.destroy(); return }
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) ?? []
    const token = protocols.length === 2 && protocols[0] === 'da-moa' ? protocols[1] : null
    void authenticatedUser(token).then(auth => {
      if (!auth.id || socket.destroyed) { socket.destroy(); return }
      const userId = auth.id
      websocket.upgrade(request, socket, head, connection => {
        websocket.subscribe(`user:${userId}`, connection)
        let authTimer
        const revalidate = async () => {
          try {
            const current = await authenticatedUser(token)
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
  return { handleRequest, handleUpgrade, close: websocket.close }
}
