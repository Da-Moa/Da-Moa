import assert from 'node:assert/strict'
import test from 'node:test'
import { sameOrigin } from './http.ts'

test('Origin validation uses the public host and forwarded protocol behind a TLS proxy', () => {
  const headers = { host: 'moa.example', 'x-forwarded-proto': 'https', origin: 'https://moa.example' }
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers })), true)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, origin: 'https://other.example' } })), false)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, host: 'moa.example/path' } })), false)
})

test('production Origin is bound to the configured Kakao callback domain', () => {
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
