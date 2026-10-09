import { Client, Pool } from 'pg'
import { channel } from 'node:diagnostics_channel'
import { format } from 'sql-formatter'

function instrumentQueries(client, instrument = true) {
  client.query = new Proxy(client.query, {
    apply(target, receiver, args) {
      if (instrument) channel('da-moa.db.query').publish({})
      if (process.env.DB_QUERY_LOG === 'true') {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text
        if (typeof sql === 'string') {
          let formatted = sql
          try { formatted = format(sql, { language: 'postgresql', tabWidth: 4, keywordCase: 'upper' }) }
          catch { /* Unsupported SQL is still logged and sent unchanged. */ }
          console.info(`SQL:\n${formatted.replace(/^/gm, '    ')}`)
        }
      }
      return Reflect.apply(target, receiver, args)
    },
  })
  return client
}

export function createDatabaseClient(value, { instrument = true, ...options } = {}) {
  const client = new Client({ connectionString: value, connectionTimeoutMillis: 10_000, ...options })
  return instrumentQueries(client, instrument)
}

export function createDatabasePool(value) {
  const pool = new Pool({
    connectionString: value, max: 10, connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000, allowExitOnIdle: true,
    statement_timeout: 15_000, lock_timeout: 10_000,
  })
  pool.on('connect', client => instrumentQueries(client))
  pool.on('error', error => console.error('Database pool idle client error', error))
  return pool
}
