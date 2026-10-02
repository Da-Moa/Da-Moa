import 'server-only'
import { getDatabasePool } from '../../../../lib/db-client.mjs'

export async function checkDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  await getDatabasePool(connectionString).query('SELECT 1')
}

export async function checkMinio(): Promise<void> {
  if (!process.env.MINIO_ENDPOINT) throw new Error('MINIO_ENDPOINT is required')
  const responses = await Promise.all(['/minio/health/cluster/read', '/minio/health/cluster'].map(path =>
    fetch(new URL(path, process.env.MINIO_ENDPOINT), { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
  ))
  if (responses.some(response => response.status !== 200)) throw new Error('MinIO storage is not ready')
}
