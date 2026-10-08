import { getPrismaClient } from '../../global/database/prisma.service'
import { runOnce } from 'graphile-worker'
import { receiptTasks } from '../../domain/settle/service/receiptWorker'
import { addReceipt } from '../../domain/settle'

export async function drainReceiptQueue() {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString || !new URL(connectionString).pathname.includes('test')) throw new Error('An isolated test database is required')
  await getPrismaClient(connectionString)
  await runOnce({ connectionString, taskList: receiptTasks, concurrency: 2, noHandleSignals: true })
}

export async function addStoredReceipt(...input: Parameters<typeof addReceipt>) {
  const result: Awaited<ReturnType<typeof addReceipt>> = await Reflect.apply(addReceipt, undefined, input)
  await drainReceiptQueue()
  return result
}
