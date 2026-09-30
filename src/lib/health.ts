import { withReadTransaction } from './db'

type Scope = 'live' | 'database' | 'minio' | 'dependencies' | 'overall'
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

  const selected = scope === 'database' || scope === 'minio' ? { [scope]: checks[scope] } : checks
  const results = await Promise.all(Object.entries(selected).map(async ([name, probe]) =>
    [name, await probe().then(() => 'ok', () => 'down')] as const,
  ))
  const healthy = results.every(([, status]) => status === 'ok')
  return Response.json(
    { status: healthy ? 'ok' : 'down', checks: { ...(scope === 'overall' ? application : {}), ...Object.fromEntries(results) } },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
