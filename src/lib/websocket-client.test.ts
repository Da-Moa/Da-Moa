import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebsocketUtil } from '../Global/Websocket/Frontend/websocket-util'

test('client topics batch invalidations, reconnect with a fresh token and stop after disposal', async t => {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static CLOSING = 2
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    close(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
    message(keys: string[]) { this.onmessage?.({ data: JSON.stringify({ type: 'invalidate', keys }) }) }
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'https:', host: 'app.example' } } })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let token = 'first-token'
  let refreshes = 0
  let releaseRefresh: (() => void) | undefined
  let invalidations = 0
  let callbacks = 0
  const websocket = createWebsocketUtil({
    getToken: () => token,
    beforeReconnect: async () => {
      refreshes++
      if (refreshes === 3) await new Promise<void>(resolve => { releaseRefresh = resolve })
      token = 'fresh-token'
      return true
    },
    onInvalidate: () => invalidations++,
  })
  try {
    const listener = () => callbacks++
    websocket.subscribe('groups', listener)
    websocket.subscribe('rounds', listener)
    const removed = websocket.subscribe('groups', () => assert.fail('unsubscribed callback'))
    await websocket.connect()
    assert.equal(refreshes, 0, 'initial connection does not fetch me')
    assert.equal(sockets[0].url, 'wss://app.example/realtime')
    assert.deepEqual(sockets[0].protocols, ['da-moa', 'first-token'])
    sockets[0].open()
    sockets[0].message(['groups', 'rounds'])
    sockets[0].message(['groups'])
    removed()
    t.mock.timers.tick(120)
    assert.equal(callbacks, 1, 'one reload per batch even across multiple topics')
    sockets[0].message(['account-number:123'])
    t.mock.timers.tick(120)
    assert.equal(invalidations, 1, 'invalid payload is ignored')
    sockets[0].close()
    t.mock.timers.tick(999)
    assert.equal(sockets.length, 1)
    t.mock.timers.tick(1)
    await Promise.resolve()
    assert.deepEqual(sockets[1].protocols, ['da-moa', 'fresh-token'])
    sockets[1].open()
    t.mock.timers.tick(120)
    assert.equal(callbacks, 2, 'reconnect reloads subscribed topics')
    sockets[1].close(4001)
    t.mock.timers.tick(0)
    await Promise.resolve()
    assert.equal(sockets.length, 3, 'expired JWT reconnects immediately')
    sockets[2].open()
    sockets[2].close()
    t.mock.timers.tick(1000)
    assert.ok(releaseRefresh)
    assert.equal(callbacks, 3)
    sockets[2].message(['groups'])
    websocket.disconnect()
    releaseRefresh()
    await Promise.resolve()
    t.mock.timers.tick(30000)
    assert.equal(sockets.length, 3, 'cleanup cancels in-flight reconnect and queued callbacks')
    assert.equal(callbacks, 3)
  } finally {
    websocket.disconnect()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket)
    else Reflect.deleteProperty(globalThis, 'WebSocket')
  }
})
