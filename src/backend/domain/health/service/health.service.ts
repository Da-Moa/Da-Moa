import { Injectable, Inject } from '@nestjs/common';
import type {
  HealthCheck,
  HealthResponseDTO,
} from '../dto/res/health.response.dto';
import { HealthRepository } from '../repository/health.repository';

export const HEALTH_WORKER_PROBES = Symbol('HEALTH_WORKER_PROBES');
export type HealthWorkerProbes = {
  worker: () => Promise<unknown>;
  workerReady: () => Promise<unknown>;
};

@Injectable()
export class HealthService {
  constructor(
    @Inject(HealthRepository)
    private readonly repository: Pick<
      HealthRepository,
      'checkDatabase' | 'getMinioHealth'
    >,
    @Inject(HEALTH_WORKER_PROBES)
    private readonly workerProbes: HealthWorkerProbes,
  ) {}

  async checkLive(): Promise<HealthResponseDTO> {
    return { status: 'ok', checks: { application: 'ok' } };
  }

  checkDatabase(): Promise<HealthResponseDTO> {
    return this.probe('database', () => this.repository.checkDatabase());
  }

  checkMinio(): Promise<HealthResponseDTO> {
    return this.probe('minio', async () => {
      const health = await this.repository.getMinioHealth();
      if (health.read !== 200 || health.write !== 200)
        throw new Error('MinIO storage is not ready');
    });
  }

  async checkDependencies(): Promise<HealthResponseDTO> {
    const results = await Promise.all([
      this.checkDatabase(),
      this.checkMinio(),
    ]);
    return this.combine(results);
  }

  async checkOverall(): Promise<HealthResponseDTO> {
    const results = await Promise.all([
      this.checkLive(),
      this.checkDependencies(),
    ]);
    return this.combine(results);
  }

  checkWorker(): Promise<HealthResponseDTO> {
    return this.probe('worker', () => this.workerProbes.worker());
  }

  async checkWorkerReady(): Promise<HealthResponseDTO> {
    const results = await Promise.all([
      this.probe('worker', () => this.workerProbes.workerReady()),
      this.checkDatabase(),
      this.checkMinio(),
    ]);
    return this.combine(results);
  }

  private async probe(
    name: HealthCheck,
    check: () => Promise<unknown>,
  ): Promise<HealthResponseDTO> {
    try {
      await check();
      return { status: 'ok', checks: { [name]: 'ok' } };
    } catch {
      return { status: 'down', checks: { [name]: 'down' } };
    }
  }

  private combine(results: HealthResponseDTO[]): HealthResponseDTO {
    return {
      status: results.every((result) => result.status === 'ok') ? 'ok' : 'down',
      checks: Object.assign({}, ...results.map((result) => result.checks)),
    };
  }
}
