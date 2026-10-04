import 'server-only'
import type { AccessToken } from '../../../lib/auth'
import { requireAccount } from '../../Auth/Backend'
import { withWriteTransaction, type Database } from '../../../lib/db'
import { replayMutation, saveMutation } from '../../../lib/mutations'
import type { MutationResult } from '../../../lib/domain-types'

export type Identity = AccessToken | null

export async function domainMutation(access: Identity, key: string, operation: string, payload: unknown, work: (client: Database, userId: string) => Promise<MutationResult>): Promise<MutationResult> {
  return withWriteTransaction(async client => {
    const account = await requireAccount(client, access)
    const replay = await replayMutation<MutationResult>(client, account.id, operation, key, payload)
    if (replay.result) return replay.result
    const result = await work(client, account.id)
    await saveMutation(client, account.id, operation, key, replay.digest, result.id, result)
    return result
  })
}
