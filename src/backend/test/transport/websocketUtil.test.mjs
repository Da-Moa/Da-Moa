import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import { createWebsocketUtil } from '../../global/websocket/websocketUtil.mjs'

test('WebSocket handshake, topic isolation, unsubscribe and ping/pong cleanup', { timeout: 10000 }, async () => {
  const websocket = createWebsocketUtil()
  const server = createServer()
  const connections = []
  const sockets = []
  let unsubscribe
  server.on('upgrade', (request, socket, head) => websocket.upgrade(request, socket, head, connection => {
    connections.push(connection)
    const cleanup = websocket.subscribe(request.url, connection)
    if (request.url === '/mine') unsubscribe = cleanup
  }))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    async function connect(topic, autoPong = true) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}${topic}`, { autoPong })
      sockets.push(socket)
      await once(socket, 'open')
      return socket
    }
    const mine = await connect('/mine')
    const other = await connect('/other')
    const dead = await connect('/dead', false)
    let otherMessages = 0
    other.on('message', () => otherMessages++)
    const received = once(mine, 'message')
    websocket.publish('/mine', { type: 'invalidate', keys: ['groups'] })
    assert.deepEqual(JSON.parse((await received)[0].toString()), { type: 'invalidate', keys: ['groups'] })
    unsubscribe()
    let mineMessages = 0
    mine.on('message', () => mineMessages++)
    websocket.publish('/mine', { type: 'invalidate', keys: ['rounds'] })
    const pongs = connections.slice(0, 2).map(connection => once(connection, 'pong'))
    websocket.ping()
    await Promise.all(pongs)
    assert.equal(otherMessages, 0)
    assert.equal(mineMessages, 0)
    const deadClosed = once(dead, 'close')
    websocket.ping()
    await deadClosed
    assert.equal(mine.readyState, WebSocket.OPEN)
    assert.equal(other.readyState, WebSocket.OPEN)
    const rejected = once(mine, 'close')
    mine.send(JSON.stringify({ subscribe: '/other' }))
    assert.equal((await rejected)[0], 1008, 'clients cannot choose unauthorized server topics')
  } finally {
    sockets.forEach(socket => socket.terminate())
    websocket.close()
    await new Promise(resolve => server.close(resolve))
  }
})
