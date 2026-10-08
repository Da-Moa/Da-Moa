import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';
import { EventEmitter } from 'node:events';
import { isUUID } from 'class-validator';
import { run, type TaskList } from 'graphile-worker';
import { RealtimePublisher } from '../../../global/util/invalidationUtil';
import { ReceiptStorage } from '../../../global/util/minio.util';
import { MAX_RECEIPT_BYTES } from '../../../../shared/domain/settle/receipt';
import { SettleRepository } from '../repository/settle.repository';

@Injectable()
export class ReceiptWorker {
  private runner?: ReturnType<typeof run>;
  private stopping?: Promise<void>;
  private readonly health = { running: false, readyWorkers: new Set<string>() };
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SettleRepository) private readonly repository: SettleRepository,
    @Inject(ReceiptStorage) private readonly storage: ReceiptStorage,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}
  // Flush completion/failure writes before the runner releases its pool.
  readonly preset = {
    worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 },
  };
  readonly tasks: TaskList = {
    store_receipt: async (payload, helpers) => {
      const data = payload as { id: string; userId: string; content: string };
      if (
        !data ||
        !isUUID(data.id, 'loose') ||
        !isUUID(data.userId, 'loose') ||
        typeof data.content !== 'string' ||
        data.content.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4
      )
        throw new Error('Invalid receipt job');
      // Retries overwrite only this receipt's deterministic object, including after a lost DB response.
      const objectKey = `receipts/${data.userId}/${data.id}.avif`;
      try {
        await this.storage.putReceipt(
          objectKey,
          Buffer.from(data.content, 'base64'),
          'image/avif',
        );
        const saved = await this.prisma.withDatabaseConnection((client) =>
          this.repository.finishReceiptStorage(client, data.id, objectKey),
        );
        if (!saved) {
          await this.storage.deleteReceiptObject(objectKey);
          return;
        }
        await this.publisher.publishRoundInvalidation(saved.round_id, {
          groupId: saved.group_id,
          userIds: saved.user_ids,
        });
      } catch (error) {
        if (helpers.job.attempts >= helpers.job.max_attempts) {
          const failed = await this.prisma.withDatabaseConnection((client) =>
            this.repository.finishReceiptStorage(client, data.id, null),
          );
          if (failed)
            await this.publisher.publishRoundInvalidation(failed.round_id, {
              groupId: failed.group_id,
              userIds: failed.user_ids,
            });
        }
        throw error;
      }
    },
  };

  async check() {
    if (process.env.RECEIPT_WORKER_ENABLED === 'false' || !this.health.running)
      throw new Error('Receipt worker is not running');
  }

  async checkReady() {
    await this.check();
    if (!this.health.readyWorkers.size)
      throw new Error('Receipt queue is not ready');
    if (
      [
        'MINIO_ENDPOINT',
        'MINIO_BUCKET',
        'MINIO_ACCESS_KEY',
        'MINIO_SECRET_KEY',
      ].some((name) => !process.env[name])
    )
      throw new Error('MinIO configuration is required');
  }

  async start() {
    await this.stopping;
    if (!this.runner) {
      const health = this.health;
      const events = new EventEmitter();
      const stopped = () => {
        health.running = false;
        health.readyWorkers.clear();
      };
      const track = (emitter: typeof events) => {
        for (const name of [
          'stop',
          'pool:gracefulShutdown',
          'pool:forcefulShutdown',
          'pool:release',
          'pool:fatalError',
        ])
          emitter.on(name, stopped);
        for (const name of ['worker:getJob:empty', 'job:start'])
          emitter.on(name, ({ worker }) =>
            health.readyWorkers.add(worker.workerId),
          );
        for (const name of [
          'worker:getJob:error',
          'worker:fatalError',
          'worker:release',
          'worker:stop',
        ])
          emitter.on(name, ({ worker }) =>
            health.readyWorkers.delete(worker.workerId),
          );
      };
      track(events);
      this.runner ??= run({
        connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
        taskList: this.tasks,
        noHandleSignals: true,
        preset: this.preset,
        concurrency: 2,
        pollInterval: 1000,
        events,
      });
      void this.runner.then((runner) => {
        if (runner.events !== events) track(runner.events);
        health.running = true;
        void runner.promise.then(stopped, (error) => {
          stopped();
          console.error('Receipt worker stopped', error);
        });
      }, stopped);
    }
    return await this.runner!;
  }

  stop() {
    if (!this.stopping) {
      this.stopping = (async () => {
        const runner = this.runner;
        if (!runner) return;
        await (await runner).stop();
        if (this.runner === runner) this.runner = undefined;
        this.health.running = false;
        this.health.readyWorkers.clear();
      })().finally(() => {
        this.stopping = undefined;
      });
    }
    return this.stopping;
  }
}
