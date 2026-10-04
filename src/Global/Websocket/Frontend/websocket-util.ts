import { parseInvalidateEvent, type ResourceKey } from '../Shared/realtime'

export type WebsocketSubscribe = (topic: ResourceKey, listener: () => void) => () => void

export function createWebsocketUtil(options: {
  getToken: () => string | null
  beforeReconnect: () => Promise<boolean>
  onInvalidate: (topics: ResourceKey[]) => void
}) {
  const listeners = new Map<ResourceKey, Set<() => void>>()
  const pending = new Map<ResourceKey, Set<() => void>>()
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let disposed = true
  let connecting = false

  const subscribe: WebsocketSubscribe = (topic, listener) => {
    const current = listeners.get(topic) ?? new Set()
    current.add(listener); listeners.set(topic, current)
    return () => { current.delete(listener); if (!current.size) listeners.delete(topic) }
  }

  function queue(topics: ResourceKey[]) {
    if (disposed) return
    for (const topic of topics) {
      const callbacks = pending.get(topic) ?? new Set<() => void>()
      listeners.get(topic)?.forEach(listener => callbacks.add(listener))
      pending.set(topic, callbacks)
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
      const callbacks = new Set<() => void>()
      const topics = [...pending.keys()]
      for (const [topic, queued] of pending) {
        queued.forEach(listener => { if (listeners.get(topic)?.has(listener)) callbacks.add(listener) })
      }
      pending.clear()
      options.onInvalidate(topics)
      callbacks.forEach(listener => listener())
    }, 120)
  }

  function reconnect(event?: CloseEvent) {
    if (disposed) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { void connect(true) }, event?.code === 4001 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)))
  }

  async function connect(refresh = false) {
    if (connecting || socket && socket.readyState < WebSocket.CLOSING) return
    disposed = false
    connecting = true
    try {
      if (refresh && !await options.beforeReconnect()) { reconnect(); return }
      if (disposed) return
      const token = options.getToken()
      if (!token) { reconnect(); return }
      // Browsers reply to server ping frames with pong automatically.
      const current = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/realtime`, ['da-moa', token])
      socket = current
      current.onopen = () => { attempts = 0; if (refresh) queue([...listeners.keys()]) }
      current.onmessage = message => { const event = parseInvalidateEvent(message.data); if (event) queue(event.keys) }
      current.onclose = reconnect
      current.onerror = () => current.close()
    } catch { reconnect() }
    finally { connecting = false }
  }

  function disconnect() {
    disposed = true
    clearTimeout(timer)
    clearTimeout(retryTimer)
    pending.clear()
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); socket = null }
  }
  return { connect, subscribe, disconnect }
}
