import assert from 'node:assert/strict'
import test from 'node:test'
import { getLoginMessage } from './login-message.ts'

test('login messages ignore inherited query parameter names', () => {
  assert.equal(getLoginMessage('invalid'), '로그인 요청이 만료되었어요. 다시 시도해 주세요')
  assert.equal(getLoginMessage('toString'), '로그인을 완료하지 못했어요. 다시 시도해 주세요')
})
