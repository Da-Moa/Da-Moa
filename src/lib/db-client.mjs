import { Client } from '@neondatabase/serverless'
import { Socket } from 'node:net'
import { channel } from 'node:diagnostics_channel'

export function createDatabaseClient(value, { instrument = true, ...options } = {}) {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname)
  const client = new Client({ connectionString: value, connectionTimeoutMillis: 10_000, ...(local ? { stream: new Socket(), ssl: false } : {}), ...options })
  if (instrument) client.query = new Proxy(client.query, {
    apply(target, receiver, args) {
      channel('da-moa.db.query').publish({})
      return Reflect.apply(target, receiver, args)
    },
  })
  return client
}
