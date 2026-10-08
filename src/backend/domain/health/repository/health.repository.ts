import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';

@Injectable()
export class HealthRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService = new PrismaService(),
  ) {}
  async checkDatabase(): Promise<void> {
    await this.prisma.client.$queryRaw`SELECT 1`;
  }
  async checkMinio(): Promise<void> {
    if (!process.env.MINIO_ENDPOINT)
      throw new Error('MINIO_ENDPOINT is required');
    const responses = await Promise.all(
      ['/minio/health/cluster/read', '/minio/health/cluster'].map((path) =>
        fetch(new URL(path, process.env.MINIO_ENDPOINT), {
          signal: AbortSignal.timeout(5000),
          cache: 'no-store',
        }),
      ),
    );
    if (responses.some((response) => response.status !== 200))
      throw new Error('MinIO storage is not ready');
  }
}
const repository = new HealthRepository();
export const checkDatabase = repository.checkDatabase.bind(repository);
export const checkMinio = repository.checkMinio.bind(repository);
