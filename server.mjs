import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import next from 'next'
import { WebSocketServer } from 'ws'
import { httpMetrics, trackHttpResponse } from './src/lib/http-metrics.mjs'

const portArg = process.argv.findIndex(value => value === '--port' || value === '-p')
const port = Number(portArg < 0 ? process.env.PORT || 3000 : process.argv[portArg + 1])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const metricsPort = process.env.METRICS_PORT ? Number(process.env.METRICS_PORT) : null
if (metricsPort !== null && (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port)) throw new Error('Invalid METRICS_PORT')
process.env.REALTIME_INTERNAL_PORT = String(port)
process.env.REALTIME_INTERNAL_SECRET = randomBytes(32).toString('hex')

// ponytail: in-process delivery supports one instance; add shared pub/sub before horizontal scaling.
const sockets = new Map()
const server = createServer((request, response) => {
  if (request.url === '/internal/realtime') {
    if (request.method !== 'POST' || request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1' && request.socket.remoteAddress !== '::1') {
      response.writeHead(403).end(); return
    }
    const received = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(process.env.REALTIME_INTERNAL_SECRET)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.writeHead(403).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 1048576) request.destroy() })
    request.on('end', () => {
      try {
        const targets = JSON.parse(body)
        if (!Array.isArray(targets) || targets.length > 10000 || !targets.every(target =>
          typeof target.userId === 'string' && /^[\w-]{1,128}$/.test(target.userId)
          && Array.isArray(target.keys) && target.keys.length > 0 && target.keys.length <= 20
          && target.keys.every(key => typeof key === 'string' && /^(me|groups|rounds|settlements|(group|group-rounds|round|settlement):[\w-]{1,128})$/.test(key)))) throw new Error('Invalid invalidation')
        for (const { userId, keys } of targets) for (const socket of sockets.get(userId) ?? []) {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'invalidate', keys }))
        }
        response.writeHead(204).end()
      } catch { response.writeHead(400).end() }
    })
    return
  }
  if (metricsPort !== null) trackHttpResponse(request, response)
  void handle(request, response)
})
const app = next({ dev: process.env.NODE_ENV !== 'production', httpServer: server, port })
const handle = app.getRequestHandler()
const websocket = new WebSocketServer({ noServer: true, clientTracking: false })

async function authenticatedUser(cookie) {
  if (!cookie) return { status: 401 }
  const response = await fetch(`http://127.0.0.1:${port}/api/me`, {
    headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  if (response.status === 401 || response.status === 403) return { status: response.status }
  if (!response.ok) throw new Error(`Realtime authentication failed (${response.status})`)
  const account = (await response.json()).data
  return account?.purpose === 'app' && account.onboardingCompletedAt && !account.deletedAt
    ? { status: 200, id: account.id } : { status: 403 }
}

server.on('upgrade', (request, socket, head) => {
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
  const cookie = request.headers.cookie
  void authenticatedUser(cookie).then(auth => {
    if (!auth.id || socket.destroyed) { socket.destroy(); return }
    const userId = auth.id
    websocket.handleUpgrade(request, socket, head, connection => {
      const connections = sockets.get(userId) ?? new Set()
      connections.add(connection); sockets.set(userId, connections)
      let authTimer
      const revalidate = async () => {
        try {
          const current = await authenticatedUser(cookie)
          if (connection.readyState !== connection.OPEN) return
          // A short-lived access cookie must refresh through the browser before reconnecting.
          if (current.status === 401) connection.close(4001)
          else if (current.id !== userId) connection.close(1008)
          else authTimer = setTimeout(revalidate, 60000)
        } catch { if (connection.readyState === connection.OPEN) connection.close(1011) }
      }
      authTimer = setTimeout(revalidate, Math.random() * 60000)
      connection.on('close', () => { clearTimeout(authTimer); connections.delete(connection); if (!connections.size) sockets.delete(userId) })
      connection.on('message', () => connection.close(1008))
      connection.on('pong', () => { connection.alive = true })
      connection.alive = true
    })
  }).catch(() => socket.destroy())
})

setInterval(() => {
  for (const connections of sockets.values()) for (const socket of connections) {
    if (!socket.alive) { socket.terminate(); continue }
    socket.alive = false
    socket.ping()
  }
}, 60000)

await app.prepare()
if (metricsPort !== null) createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/metrics') { response.writeHead(404).end(); return }
  response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).end(httpMetrics())
}).listen(metricsPort, process.env.HOST || '127.0.0.1')
server.listen(port, process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'), () => console.log(`Ready on port ${port}`))
