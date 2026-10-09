import { getPrismaClient } from '../support/domainTestSupport';
import { runOnce } from 'graphile-worker';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { testProvider } from '../support/domainTestSupport';
import { addReceipt } from '../support/domainTestSupport';

export async function drainReceiptQueue(worker?: ReceiptWorker) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || !new URL(connectionString).pathname.includes('test'))
    throw new Error('An isolated test database is required');
  await getPrismaClient(connectionString);
  const provider = worker ?? (await testProvider(ReceiptWorker));
  await runOnce({
    connectionString,
    taskList: provider.tasks,
    preset: provider.preset,
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
