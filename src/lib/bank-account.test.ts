import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBankAccountInput } from './bank-account.ts'

test('manual bank input keeps leading zeroes and rejects former verification fields', () => {
  const input = { bankCode: '004', accountNumber: '00-123 456', accountHolder: ' 테스트 ', expectedBankVersion: 0 }
  assert.deepEqual(normalizeBankAccountInput(input), {
    bankCode: '004', bankName: 'KB국민은행', accountNumber: '00123456', accountHolder: '테스트', expectedBankVersion: 0, confirmRejoin: false,
  })
  assert.throws(() => normalizeBankAccountInput({ ...input, birthDate: '1990-01-01' }))
  assert.throws(() => normalizeBankAccountInput({ ...input, verifyWithOpenBanking: true }))
  assert.deepEqual(normalizeBankAccountInput({ ...input, verifyWithOpenBanking: false }), normalizeBankAccountInput(input))
})
