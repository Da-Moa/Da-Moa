import { ApiResponseDto } from '../../../../global/apiPayload/response.dto';
import { healthSuccess } from '../../code/health.success.code';

export type HealthCheck = 'application' | 'database' | 'minio' | 'worker';
export type HealthStatus = 'ok' | 'down';

export type HealthResponseDTO = {
  status: HealthStatus;
  checks: Partial<Record<HealthCheck, HealthStatus>>;
};

export class HealthResponseDto<T> extends ApiResponseDto<T> {
  constructor(data: T) {
    super(healthSuccess, data);
  }
}
