import assert from 'node:assert/strict'
import test from 'node:test'
import { sameOrigin } from '../../global/apiPayload/http.ts'

test('TLS 프록시 뒤에서 공개 호스트와 전달된 프로토콜로 Origin을 검증한다', () => {
  const headers = { host: 'moa.example', 'x-forwarded-proto': 'https', origin: 'https://moa.example' }
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers })), true)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, origin: 'https://other.example' } })), false)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, host: 'moa.example/path' } })), false)
})

test('운영 Origin을 설정된 카카오 콜백 도메인에 연결한다', () => {
  const oldEnvironment = process.env.NODE_ENV
  const oldRedirect = process.env.KAKAO_REDIRECT_URI
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.KAKAO_REDIRECT_URI = 'https://moa.example/auth/v1/kakao'
  try {
    const headers = { host: 'moa.example:443', 'x-forwarded-proto': 'https', origin: 'https://moa.example' }
    assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers })), true)
    assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, host: 'other.example', origin: 'https://other.example' } })), false)
    assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, host: 'moa.example@other.example' } })), false)
  } finally {
    if (oldEnvironment === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: oldEnvironment })
    if (oldRedirect === undefined) delete process.env.KAKAO_REDIRECT_URI; else process.env.KAKAO_REDIRECT_URI = oldRedirect
  }
})

test('운영 URI 목록의 동일 Origin 요청을 허용하고 교차 Origin 변경 요청을 거부한다', () => {
  const oldEnvironment = process.env.NODE_ENV
  const oldRedirect = process.env.KAKAO_REDIRECT_URI
  Object.assign(process.env, { NODE_ENV: 'production', KAKAO_REDIRECT_URI: 'https://moa.example/auth/v1/kakao,https://second.example/auth/v1/kakao' })
  try {
    for (const host of ['moa.example', 'second.example']) {
      const headers = { host, 'x-forwarded-proto': 'https', origin: `https://${host}` }
      assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers })), true)
      assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, origin: host === 'moa.example' ? 'https://second.example' : 'https://moa.example' } })), false)
    }
    assert.equal(sameOrigin(new Request('https://attacker.example/api/groups', { headers: { origin: 'https://attacker.example' } })), false)
    process.env.KAKAO_REDIRECT_URI += ',invalid-uri'
    assert.equal(sameOrigin(new Request('https://moa.example/api/groups', { headers: { origin: 'https://moa.example' } })), false)
  } finally {
    if (oldEnvironment === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: oldEnvironment })
    if (oldRedirect === undefined) delete process.env.KAKAO_REDIRECT_URI; else process.env.KAKAO_REDIRECT_URI = oldRedirect
  }
})
