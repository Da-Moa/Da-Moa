import assert from 'node:assert/strict'
import test from 'node:test'
import { requireAccount } from './authorization.ts'
import type { Database } from './db.ts'
import { AppError } from './errors.ts'

const access = { userId: 'u', sessionId: 's', issuedAt: 1 }
const row = {
  id: 'u', display_name: '사용자', email: null, profile_image_url: null,
  bank_name: '은행', account_number: '0012', account_holder: '사용자',
  bank_code: null, bank_verified_at: null, bank_version: 0,
  deleted_at: null, onboarding_completed_at: '1', purpose: 'app',
}
const client = (rows: object[]) => ({ query: async () => ({ rows }) }) as unknown as Database

test('authorization checks live session and blocks deleted or onboarding sessions from normal features', async () => {
  const unauthorized = (error: unknown) => error instanceof AppError && error.status === 401
  const onboarding = (error: unknown) => error instanceof AppError && error.code === 'onboarding_required'
  await assert.rejects(requireAccount(client([row]), null), unauthorized)
  await assert.rejects(requireAccount(client([]), access), unauthorized)
  await assert.rejects(requireAccount(client([{ ...row, deleted_at: '2' }]), access), unauthorized)
  await assert.rejects(requireAccount(client([{ ...row, purpose: 'onboarding' }]), access), onboarding)
  const returning = await requireAccount(client([{ ...row, purpose: 'onboarding', deleted_at: '2' }]), access, true)
  assert.equal(returning.deletedAt, 2)
  assert.equal(returning.purpose, 'onboarding')
  assert.equal((await requireAccount(client([row]), access)).accountNumber, '0012')
})
