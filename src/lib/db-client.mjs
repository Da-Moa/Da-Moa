import { Client, Pool } from 'pg'
import { channel } from 'node:diagnostics_channel'

function instrumentQueries(client) {
  client.query = new Proxy(client.query, {
    apply(target, receiver, args) {
      channel('da-moa.db.query').publish({})
      return Reflect.apply(target, receiver, args)
    },
  })
  return client
}

export function createDatabaseClient(value, { instrument = true, ...options } = {}) {
  const client = new Client({ connectionString: value, connectionTimeoutMillis: 10_000, ...options })
  return instrument ? instrumentQueries(client) : client
}

// Reuse pools across Next.js module reloads; separate URLs keep test databases isolated.
const pools = globalThis[Symbol.for('da-moa.database.pools')] ??= new Map()

export function getDatabasePool(value) {
  if (!pools.has(value)) {
    const pool = new Pool({
      connectionString: value, max: 10, connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000, allowExitOnIdle: true,
    })
    pool.on('connect', instrumentQueries)
    pool.on('error', error => console.error('Database pool idle client error', error))
    pools.set(value, pool)
  }
  return pools.get(value)
}
