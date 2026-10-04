// This repository is also loaded by the standalone Node server.
import { getDatabasePool } from '../../../../lib/db-client.mjs'

export async function getRealtimeUserState(userId: string) {
  const database = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!database) throw new Error('DATABASE_URL is required')
  const query = {
    text: 'SELECT id, deleted_at, onboarding_completed_at FROM users WHERE id = $1',
    values: [userId], query_timeout: 10000,
  }
  const { rows: [account] } = await getDatabasePool(database).query<{ id: string; deleted_at: string | null; onboarding_completed_at: string | null }>(query)
  return account
}
