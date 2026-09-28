import assert from 'node:assert/strict'
import test from 'node:test'
import { sameOrigin } from './http.ts'

test('Origin validation uses the public host and forwarded protocol behind a TLS proxy', () => {
  const headers = { host: 'moa.example', 'x-forwarded-proto': 'https', origin: 'https://moa.example' }
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers })), true)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, origin: 'https://other.example' } })), false)
  assert.equal(sameOrigin(new Request('http://localhost:3000/api/groups', { headers: { ...headers, host: 'moa.example/path' } })), false)
})
