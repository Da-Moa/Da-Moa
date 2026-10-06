export type HealthScope = 'live' | 'database' | 'minio' | 'dependencies' | 'overall' | 'worker' | 'worker/readyz'
export type HealthStatus = 'ok' | 'down'

export type HealthRequestDTO = { scope: HealthScope }
export type HealthResponseDTO = {
  status: HealthStatus
  checks: Partial<Record<'application' | 'database' | 'minio' | 'worker', HealthStatus>>
}
