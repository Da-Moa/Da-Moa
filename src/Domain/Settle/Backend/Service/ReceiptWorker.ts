import 'server-only'
import { run, type TaskList } from 'graphile-worker'
import { withDatabaseConnection, putReceipt, deleteReceiptObject } from '../../../../Global/Util/Backend'
import { MAX_RECEIPT_BYTES } from '../../Shared/receipt'
import { publishRoundInvalidation } from '../Controller/SettleInvalidation'
import { finishReceiptStorage } from '../Repository/SettleRepository'

export const receiptTasks: TaskList = {
  store_receipt: async (payload, helpers) => {
    const data = payload as { id: string; userId: string; content: string }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!data || !uuid.test(data.id) || !uuid.test(data.userId) || typeof data.content !== 'string'
        || data.content.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4) throw new Error('Invalid receipt job')
    // Retries overwrite only this receipt's deterministic object, including after a lost DB response.
    const objectKey = `receipts/${data.userId}/${data.id}.avif`
    try {
      await putReceipt(objectKey, Buffer.from(data.content, 'base64'), 'image/avif')
      const saved = await withDatabaseConnection(client => finishReceiptStorage(client, data.id, objectKey))
      if (!saved) { await deleteReceiptObject(objectKey); return }
      await publishRoundInvalidation(saved.round_id, { groupId: saved.group_id, userIds: saved.user_ids })
    } catch (error) {
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        const failed = await withDatabaseConnection(client => finishReceiptStorage(client, data.id, null))
        if (failed) await publishRoundInvalidation(failed.round_id, { groupId: failed.group_id, userIds: failed.user_ids })
      }
      throw error
    }
  },
}

const workerKey = Symbol.for('da-moa.receipt-worker')
export async function startReceiptWorker() {
  const state = globalThis as typeof globalThis & { [workerKey]?: ReturnType<typeof run> }
  state[workerKey] ??= run({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    taskList: receiptTasks, concurrency: 2, pollInterval: 1000 })
  const runner = await state[workerKey]
  void runner.promise.catch(error => console.error('Receipt worker stopped', error))
  return runner
}
