import { withReadTransaction } from './db'

type Scope = 'live' | 'dependencies' | 'overall'
type Probe = () => Promise<unknown>
export async function checkMinio() {
  if (!process.env.MINIO_ENDPOINT) throw new Error('MINIO_ENDPOINT is required')
  const responses = await Promise.all(['/minio/health/cluster/read', '/minio/health/cluster'].map(path =>
    fetch(new URL(path, process.env.MINIO_ENDPOINT), { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
  ))
  if (responses.some(response => response.status !== 200)) throw new Error('MinIO storage is not ready')
}

const probes = {
  database: () => withReadTransaction(client => client.query('SELECT 1')),
  minio: checkMinio,
}

export async function healthResponse(scope: Scope, checks: { database: Probe; minio: Probe } = probes) {
  const application = { application: 'ok' }
  if (scope === 'live') return Response.json({ status: 'ok', checks: application }, { headers: { 'Cache-Control': 'no-store' } })

  const [database, minio] = await Promise.all([
    checks.database().then(() => 'ok', () => 'down'),
    checks.minio().then(() => 'ok', () => 'down'),
  ])
  const healthy = database === 'ok' && minio === 'ok'
  return Response.json(
    { status: healthy ? 'ok' : 'down', checks: { ...(scope === 'overall' ? application : {}), database, minio } },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
