import { ApiResponseDto } from '../../../../global/apiPayload/response.dto';
import { healthSuccess } from '../../code/health.success.code';

export type HealthScope =
  | 'live'
  | 'database'
  | 'minio'
  | 'dependencies'
  | 'overall'
  | 'worker'
  | 'worker/readyz';
export type HealthStatus = 'ok' | 'down';

export type HealthResponseDTO = {
  status: HealthStatus;
  checks: Partial<
    Record<'application' | 'database' | 'minio' | 'worker', HealthStatus>
  >;
};

export class HealthResponseDto<T> extends ApiResponseDto<T> {
  constructor(data: T) {
    super(healthSuccess, data);
  }
}

export type { HealthRequestDTO } from '../req/health.request.dto';
