import assert from 'node:assert/strict'
import test from 'node:test'
import { openApiDocument } from './openapi.ts'

test('OpenAPI document uses the Swagger UI-compatible 3.0 dialect', () => {
  assert.equal(openApiDocument.openapi, '3.0.3')
  assert.equal(JSON.stringify(openApiDocument).includes('"const"'), false)
})

test('OpenAPI documents a recoverable refresh storage failure', () => {
  const refresh = openApiDocument.paths['/api/auth/refresh'].post

  assert.equal(refresh.responses['503'].$ref, '#/components/responses/RefreshUnavailable')
  assert.equal(
    openApiDocument.components.responses.RefreshUnavailable.content['application/json'].example.error,
    'refresh_unavailable',
  )
  assert.match(
    openApiDocument.paths['/api/auth/logout'].post.description,
    /리프레시 토큰을 우선 사용하고, 없으면 유효한 액세스 토큰/,
  )
})
