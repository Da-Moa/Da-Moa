import { getPrismaClient } from '../../../global/database/prisma.service';
import { EventEmitter } from 'node:events';
import { isUUID } from 'class-validator';
import { run, type TaskList } from 'graphile-worker';
import {
  withDatabaseConnection,
  putReceipt,
  deleteReceiptObject,
  publishRoundInvalidation,
} from '../../../global/util';
import { MAX_RECEIPT_BYTES } from '../../../../shared/domain/settle/receipt';
import { finishReceiptStorage } from '../repository/settle.repository';

export const receiptTasks: TaskList = {
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
      await putReceipt(
        objectKey,
        Buffer.from(data.content, 'base64'),
        'image/avif',
      );
      const saved = await withDatabaseConnection((client) =>
        finishReceiptStorage(client, data.id, objectKey),
      );
      if (!saved) {
        await deleteReceiptObject(objectKey);
        return;
      }
      await publishRoundInvalidation(saved.round_id, {
        groupId: saved.group_id,
        userIds: saved.user_ids,
      });
    } catch (error) {
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        const failed = await withDatabaseConnection((client) =>
          finishReceiptStorage(client, data.id, null),
        );
        if (failed)
          await publishRoundInvalidation(failed.round_id, {
            groupId: failed.group_id,
            userIds: failed.user_ids,
          });
      }
      throw error;
    }
  },
};

const workerKey = Symbol.for('da-moa.receipt-worker');
const healthKey = Symbol.for('da-moa.receipt-worker.health');
type WorkerHealth = { running: boolean; readyWorkers: Set<string> };
type WorkerState = typeof globalThis & {
  [workerKey]?: ReturnType<typeof run>;
  [healthKey]?: WorkerHealth;
};

export async function checkReceiptWorker() {
  if (
    process.env.RECEIPT_WORKER_ENABLED === 'false' ||
    !(globalThis as WorkerState)[healthKey]?.running
  )
    throw new Error('Receipt worker is not running');
}

export async function checkReceiptWorkerReady() {
  await checkReceiptWorker();
  if (!(globalThis as WorkerState)[healthKey]?.readyWorkers.size)
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

export async function startReceiptWorker() {
  const state = globalThis as WorkerState;
  if (!state[healthKey]) {
    const database = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (database) await getPrismaClient(database);
    const health: WorkerHealth = (state[healthKey] = {
      running: false,
      readyWorkers: new Set<string>(),
    });
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
    state[workerKey] ??= run({
      connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
      taskList: receiptTasks,
      concurrency: 2,
      pollInterval: 1000,
      events,
    });
    void state[workerKey].then((runner) => {
      // Attach to the existing runner too when development reloads older instrumentation.
      if (runner.events !== events) track(runner.events);
      health.running = true;
      void runner.promise.then(stopped, (error) => {
        stopped();
        console.error('Receipt worker stopped', error);
      });
    }, stopped);
  }
  return await state[workerKey]!;
}

export async function stopReceiptWorker() {
  const state = globalThis as WorkerState;
  if (state[workerKey]) await (await state[workerKey]).stop();
}
