export type HealthScope = 'live' | 'database' | 'minio' | 'dependencies' | 'overall'
export type HealthStatus = 'ok' | 'down'

export type HealthRequestDTO = { scope: HealthScope }
export type HealthResponseDTO = {
  status: HealthStatus
  checks: Partial<Record<'application' | 'database' | 'minio', HealthStatus>>
}
