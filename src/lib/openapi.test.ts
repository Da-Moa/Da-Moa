import assert from 'node:assert/strict'
import test from 'node:test'
import { openApiDocument } from './openapi.ts'

test('OpenAPI document uses the Swagger UI-compatible 3.0 dialect', () => {
  assert.equal(openApiDocument.openapi, '3.0.3')
  assert.equal(JSON.stringify(openApiDocument).includes('"const"'), false)
})
