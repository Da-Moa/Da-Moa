import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import next from 'next'
import { WebSocketServer } from 'ws'

const portArg = process.argv.findIndex(value => value === '--port' || value === '-p')
const port = Number(portArg < 0 ? process.env.PORT || 3000 : process.argv[portArg + 1])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
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
  void handle(request, response)
})
const app = next({ dev: process.env.NODE_ENV !== 'production', httpServer: server, port })
const handle = app.getRequestHandler()
const websocket = new WebSocketServer({ noServer: true, clientTracking: false })

async function authenticatedUser(cookie) {
  if (!cookie) return null
  const response = await fetch(`http://127.0.0.1:${port}/api/me`, {
    headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) return null
  const account = (await response.json()).data
  return account?.purpose === 'app' && account.onboardingCompletedAt && !account.deletedAt ? account.id : null
}

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/realtime') return
  const origin = request.headers.origin
  const host = request.headers.host
  let allowed = false
  try { allowed = Boolean(origin && host && ['http:', 'https:'].includes(new URL(origin).protocol) && new URL(origin).host === host) } catch { /* Invalid Origin. */ }
  if (!allowed) { socket.destroy(); return }
  const cookie = request.headers.cookie
  void authenticatedUser(cookie).then(userId => {
    if (!userId || socket.destroyed) { socket.destroy(); return }
    websocket.handleUpgrade(request, socket, head, connection => {
      const connections = sockets.get(userId) ?? new Set()
      connections.add(connection); sockets.set(userId, connections)
      connection.on('close', () => { connections.delete(connection); if (!connections.size) sockets.delete(userId) })
      connection.on('message', () => connection.close(1008))
      connection.on('pong', () => { connection.alive = true })
      connection.cookie = cookie
      connection.alive = true
    })
  }).catch(() => socket.destroy())
})

setInterval(() => {
  for (const [userId, connections] of sockets) for (const socket of connections) {
    if (!socket.alive) { socket.terminate(); continue }
    socket.alive = false
    socket.ping()
    void authenticatedUser(socket.cookie).then(current => { if (current !== userId) socket.close(1008) }).catch(() => socket.close(1011))
  }
}, 60000)

await app.prepare()
server.listen(port, process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'), () => console.log(`Ready on port ${port}`))
