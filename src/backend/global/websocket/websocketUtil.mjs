import { clearInterval, setInterval } from 'node:timers'
import { WebSocketServer } from 'ws'

export function createWebsocketUtil() {
  const server = new WebSocketServer({ noServer: true, clientTracking: false })
  // ponytail: in-process topics support one instance; add shared pub/sub before horizontal scaling.
  const topics = new Map()
  const connections = new Set()

  function subscribe(topic, socket) {
    const subscribers = topics.get(topic) ?? new Set()
    subscribers.add(socket); topics.set(topic, subscribers)
    return () => { subscribers.delete(socket); if (!subscribers.size) topics.delete(topic) }
  }

  function publish(topic, message) {
    const payload = JSON.stringify(message)
    for (const socket of topics.get(topic) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(payload)
    }
  }

  function ping() {
    for (const socket of connections) {
      if (!socket.alive) { socket.terminate(); continue }
      socket.alive = false
      socket.ping()
    }
  }

  function upgrade(request, socket, head, connected) {
    server.handleUpgrade(request, socket, head, connection => {
      connections.add(connection)
      connection.alive = true
      connection.on('pong', () => { connection.alive = true })
      connection.on('message', () => connection.close(1008))
      connection.on('error', () => connection.terminate())
      connection.on('close', () => {
        connections.delete(connection)
        for (const [topic, subscribers] of topics) {
          subscribers.delete(connection)
          if (!subscribers.size) topics.delete(topic)
        }
      })
      connected(connection)
    })
  }

  const heartbeat = setInterval(ping, 60000)
  heartbeat.unref()
  function close() {
    clearInterval(heartbeat)
    for (const socket of connections) socket.terminate()
    server.close()
  }
  return { upgrade, subscribe, publish, ping, close }
}
