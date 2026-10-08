import {
  Inject,
  Injectable,
  type INestApplication,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { PrismaService } from '../database/prisma.service';
import { RealtimeTransport } from '../websocket/realtimeTransport';
import { RateLimitService } from '../rateLimit/rateLimit.service';
import { MetricsServer } from '../monitoring/metricsServer';
import { FrontendRuntime } from './frontendRuntime';
import { HttpDrain } from './httpDrain';
import type { Request, Response, NextFunction } from 'express';

export type RuntimeOptions = {
  frontend?: { dev: boolean; port: number };
  metricsPort?: number;
  host: string;
  startWorker?: boolean;
};

@Injectable()
export class RuntimeLifecycle
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private options?: RuntimeOptions;
  private draining?: Promise<void>;
  private closing?: Promise<void>;
  private deadline?: ReturnType<typeof setTimeout>;
  private failures: unknown[] = [];
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReceiptWorker) private readonly worker: ReceiptWorker,
    @Inject(RealtimeTransport) private readonly realtime: RealtimeTransport,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(MetricsServer) private readonly metrics: MetricsServer,
    @Inject(FrontendRuntime) private readonly frontend: FrontendRuntime,
    @Inject(HttpDrain) private readonly http: HttpDrain,
  ) {}

  async prepare(app: INestApplication, options: RuntimeOptions) {
    if (this.options || this.draining)
      throw new Error('Runtime already prepared or stopping');
    this.options = options;
    this.http.attach(app.getHttpServer());
    this.realtime.attach(app.getHttpServer());
    app.use(
      (_request: Request, response: Response, nextRoute: NextFunction) => {
        if (this.draining) {
          response.status(503).set('Connection', 'close').end();
          return;
        }
        nextRoute();
      },
    );
    if (options.frontend)
      await this.frontend.prepare(app, this.rateLimit, {
        ...options.frontend,
        metrics: options.metricsPort !== undefined,
      });
  }

  async onApplicationBootstrap() {
    if (!this.options) return;
    const database = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (database)
      await this.prisma.client
        .$connect()
        .catch(() =>
          console.warn(
            'Backend database initialization unavailable; requests will retry',
          ),
        );
    if (
      database &&
      this.options.startWorker !== false &&
      process.env.RECEIPT_WORKER_ENABLED !== 'false'
    )
      await this.worker.start();
    if (this.options.metricsPort !== undefined)
      await this.metrics.start(this.options.metricsPort, this.options.host);
  }

  beforeApplicationShutdown() {
    this.draining ??= (async () => {
      this.deadline = setTimeout(() => {
        console.error('Application shutdown timed out');
        process.exit(1);
      }, 10_000);
      this.deadline.unref();
      const results = await Promise.allSettled([
        this.realtime.close(),
        this.worker.stop(),
        this.metrics.stop(),
      ]);
      this.failures.push(
        ...results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason),
      );
      this.rateLimit.close();
      this.http.close();
    })();
    return this.draining;
  }

  onApplicationShutdown() {
    this.closing ??= (async () => {
      await this.beforeApplicationShutdown();
      const frontend = await Promise.allSettled([this.frontend.close()]);
      this.failures.push(
        ...frontend
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason),
      );
      try {
        await this.prisma.close();
      } catch (error) {
        this.failures.push(error);
      }
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = undefined;
      if (this.failures.length)
        throw new AggregateError(this.failures, 'Application shutdown failed');
    })();
    return this.closing;
  }
}
