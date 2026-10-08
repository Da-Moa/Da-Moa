import { Injectable, Inject } from '@nestjs/common';
import type {
  HealthRequestDTO,
  HealthResponseDTO,
  HealthStatus,
} from '../dto/res/health.response.dto';
import { HealthRepository } from '../repository/health.repository';
import { checkReceiptWorker, checkReceiptWorkerReady } from '../../settle';

export type HealthProbes = {
  database: () => Promise<unknown>;
  minio: () => Promise<unknown>;
  worker?: () => Promise<unknown>;
  workerReady?: () => Promise<unknown>;
};
@Injectable()
export class HealthService {
  constructor(
    @Inject(HealthRepository)
    private readonly repository: HealthRepository = new HealthRepository(),
  ) {}
  async checkHealth(
    { scope }: HealthRequestDTO,
    checks: HealthProbes = {
      database: () => this.repository.checkDatabase(),
      minio: () => this.repository.checkMinio(),
      worker: checkReceiptWorker,
      workerReady: checkReceiptWorkerReady,
    },
  ): Promise<HealthResponseDTO> {
    if (scope === 'live')
      return { status: 'ok', checks: { application: 'ok' } };

    const selected =
      scope === 'worker'
        ? { worker: checks.worker ?? checkReceiptWorker }
        : scope === 'worker/readyz'
          ? {
              worker: checks.workerReady ?? checkReceiptWorkerReady,
              database: checks.database,
              minio: checks.minio,
            }
          : scope === 'database' || scope === 'minio'
            ? { [scope]: checks[scope] }
            : { database: checks.database, minio: checks.minio };
    const results = await Promise.all(
      Object.entries(selected).map(
        async ([name, probe]) =>
          [
            name,
            await probe().then(
              (): HealthStatus => 'ok',
              (): HealthStatus => 'down',
            ),
          ] as const,
      ),
    );
    return {
      status: results.every(([, status]) => status === 'ok') ? 'ok' : 'down',
      checks: {
        ...(scope === 'overall' ? { application: 'ok' as const } : {}),
        ...Object.fromEntries(results),
      },
    };
  }
}
const service = new HealthService();
export const checkHealth = service.checkHealth.bind(service);
