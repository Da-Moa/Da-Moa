import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';

@Injectable()
export class HealthRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}
  async checkDatabase(): Promise<void> {
    await this.prisma.client.$queryRaw`SELECT 1`;
  }
  async getMinioHealth(): Promise<{ read: number; write: number }> {
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
    return { read: responses[0].status, write: responses[1].status };
  }
}
