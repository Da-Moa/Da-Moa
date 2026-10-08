import { getPrismaClient } from '../../global/database/prisma.service';
import { runOnce } from 'graphile-worker';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { testProvider } from '../domainTestSupport';
import { addReceipt } from '../domainTestSupport';

export async function drainReceiptQueue(worker?: ReceiptWorker) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || !new URL(connectionString).pathname.includes('test'))
    throw new Error('An isolated test database is required');
  await getPrismaClient(connectionString);
  await runOnce({
    connectionString,
    taskList: (worker ?? (await testProvider(ReceiptWorker))).tasks,
    concurrency: 2,
    noHandleSignals: true,
  });
}

export async function addStoredReceipt(
  ...input: Parameters<typeof addReceipt>
) {
  const result: Awaited<ReturnType<typeof addReceipt>> = await Reflect.apply(
    addReceipt,
    undefined,
    input,
  );
  await drainReceiptQueue();
  return result;
}
