import 'server-only'
import type { HealthRequestDTO, HealthResponseDTO, HealthStatus } from '../../Shared/DTO/HealthDTO'
import { checkDatabase, checkMinio } from '../Repository/HealthRepository'
import { checkReceiptWorker, checkReceiptWorkerReady } from '../../../Settle/Backend'

export type HealthProbes = { database: () => Promise<unknown>; minio: () => Promise<unknown>; worker?: () => Promise<unknown>; workerReady?: () => Promise<unknown> }
const probes: HealthProbes = {
  database: checkDatabase,
  minio: checkMinio,
  worker: checkReceiptWorker,
  workerReady: checkReceiptWorkerReady,
}

export async function checkHealth({ scope }: HealthRequestDTO, checks: HealthProbes = probes): Promise<HealthResponseDTO> {
  if (scope === 'live') return { status: 'ok', checks: { application: 'ok' } }

  const selected = scope === 'worker' ? { worker: checks.worker ?? checkReceiptWorker }
    : scope === 'worker/readyz' ? { worker: checks.workerReady ?? checkReceiptWorkerReady, database: checks.database, minio: checks.minio }
    : scope === 'database' || scope === 'minio' ? { [scope]: checks[scope] }
    : { database: checks.database, minio: checks.minio }
  const results = await Promise.all(Object.entries(selected).map(async ([name, probe]) =>
    [name, await probe().then((): HealthStatus => 'ok', (): HealthStatus => 'down')] as const,
  ))
  return {
    status: results.every(([, status]) => status === 'ok') ? 'ok' : 'down',
    checks: { ...(scope === 'overall' ? { application: 'ok' as const } : {}), ...Object.fromEntries(results) },
  }
}
