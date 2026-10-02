import 'server-only'
import type { HealthRequestDTO, HealthResponseDTO, HealthStatus } from '../../Shared/DTO/HealthDTO'
import { checkDatabase, checkMinio } from '../Repository/HealthRepository'

export type HealthProbes = { database: () => Promise<unknown>; minio: () => Promise<unknown> }
const probes: HealthProbes = {
  database: checkDatabase,
  minio: checkMinio,
}

export async function checkHealth({ scope }: HealthRequestDTO, checks: HealthProbes = probes): Promise<HealthResponseDTO> {
  if (scope === 'live') return { status: 'ok', checks: { application: 'ok' } }

  const selected = scope === 'database' || scope === 'minio' ? { [scope]: checks[scope] } : checks
  const results = await Promise.all(Object.entries(selected).map(async ([name, probe]) =>
    [name, await probe().then((): HealthStatus => 'ok', (): HealthStatus => 'down')] as const,
  ))
  return {
    status: results.every(([, status]) => status === 'ok') ? 'ok' : 'down',
    checks: { ...(scope === 'overall' ? { application: 'ok' as const } : {}), ...Object.fromEntries(results) },
  }
}
