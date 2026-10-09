import assert from 'node:assert/strict'
import test from 'node:test'
import { getLoginMessage } from '../../global/util/loginMessage.ts'

test('로그인 메시지가 상속된 쿼리 파라미터 이름을 무시한다', () => {
  assert.equal(getLoginMessage('invalid'), '로그인 요청이 만료되었어요. 다시 시도해 주세요')
  assert.equal(getLoginMessage('toString'), '로그인을 완료하지 못했어요. 다시 시도해 주세요')
})
