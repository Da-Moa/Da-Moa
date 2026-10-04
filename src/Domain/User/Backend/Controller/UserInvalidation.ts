import 'server-only'
import { publishInvalidations, realtimeEnabled } from '../../../../Global/Websocket/Backend'
import { getBankSettlementAudience } from '../../../Settle/Backend'

export async function publishBankInvalidation(userId: string) {
  if (!realtimeEnabled()) return
  // Refresh the owner's account even if the separate recipient lookup fails.
  await publishInvalidations([{ userIds: [userId], keys: ['me'] }])
  try {
    const recipients = await getBankSettlementAudience(userId)
    await publishInvalidations(recipients.map(row => ({ userIds: [row.sender_id], keys: [`settlement:${row.round_id}`] })))
  } catch { console.error('Realtime bank invalidation failed') }
}
