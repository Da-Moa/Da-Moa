import 'server-only'
import type { HealthRequestDTO, HealthScope } from '../../Shared/DTO/HealthDTO'
import { checkHealth, type HealthProbes } from '../Service/HealthService'

export async function getHealthResponse(check?: string[], probes?: HealthProbes): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  const scope = check?.join('/') || 'overall'
  if (!['overall', 'live', 'database', 'minio', 'dependencies', 'worker', 'worker/readyz'].includes(scope) || scope === 'overall' && check?.length) {
    return Response.json({ error: 'not_found' }, { status: 404, headers })
  }
  const request: HealthRequestDTO = { scope: scope as HealthScope }
  const result = await checkHealth(request, probes)
  return Response.json(result, { status: result.status === 'ok' ? 200 : 503, headers })
}
