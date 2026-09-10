import nextEnv from '@next/env'
import { createDatabaseClient } from '../src/lib/db.ts'
import { applyMigrations } from './migrations.mjs'

nextEnv.loadEnvConfig(process.cwd())
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!connectionString) throw new Error('DATABASE_URL is required')
if (!globalThis.WebSocket) throw new Error('Node.js 22.18 or newer with native WebSocket is required')
const client = createDatabaseClient(connectionString)
try {
  await client.connect()
  await applyMigrations(client)
  console.info('Database migrations complete')
} finally {
  await client.end()
}
