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

type DocumentedOperation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>
  requestBody?: { content: Record<string, { schema: { required?: string[] } }> }
  responses: Record<string, unknown>
  description: string
}
type DocumentedSchema = {
  required?: string[]
  properties?: Record<string, DocumentedSchema>
  enum?: string[]
  additionalProperties?: boolean
  maxItems?: number
  description?: string
}
const paths = openApiDocument.paths as unknown as Record<string, Record<string, DocumentedOperation> & {
  parameters?: Array<{ name: string; in: string; required?: boolean }>
}>

test('every group, expense and settlement endpoint has documented authorization and mutation contracts', () => {
  const mutations = [
    ['/api/groups', 'post'], ['/api/groups/{groupId}', 'delete'], ['/api/groups/{groupId}/rounds', 'post'],
    ['/api/groups/{groupId}/invites', 'post'], ['/api/groups/{groupId}/invites/{inviteId}', 'delete'],
    ['/api/invites/{token}/accept', 'post'], ['/api/me/bank-account', 'put'],
    ['/api/rounds/{roundId}/expenses', 'post'], ['/api/rounds/{roundId}/expenses/{expenseId}', 'patch'],
    ['/api/rounds/{roundId}/expenses/{expenseId}', 'delete'],
    ['/api/rounds/{roundId}/expenses/{expenseId}/receipts', 'post'],
    ['/api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId}', 'delete'],
    ['/api/rounds/{roundId}/members/{userId}/exclude', 'post'],
    ['/api/rounds/{roundId}/settlement-check', 'post'],
    ...['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].map(command => [`/api/rounds/{roundId}/${command}`, 'post']),
    ['/api/rounds/{roundId}', 'delete'],
  ]
  for (const [path, method] of mutations) {
    const operation = paths[path]?.[method]
    assert.ok(operation, `${method} ${path}`)
    assert.ok(operation.parameters?.some(parameter => parameter.name === 'Idempotency-Key' && parameter.required), path)
    assert.ok(operation.parameters?.some(parameter => parameter.name === 'Origin' && parameter.required), path)
    assert.ok(operation.responses['409'], path)
    assert.ok(operation.responses['503'], path)
    if (path.startsWith('/api/rounds/')) {
      const content = operation.requestBody?.content
      const schema = content?.['application/json']?.schema ?? content?.['multipart/form-data']?.schema
      assert.ok(schema?.required?.includes('expectedVersion'), path)
    }
  }
  for (const [path, item] of Object.entries(paths)) {
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(item.parameters?.some(parameter => parameter.name === name && parameter.in === 'path' && parameter.required), `${path}: ${name}`)
    }
  }
})

test('OpenAPI component references resolve and financial privacy rules remain explicit', () => {
  const document = openApiDocument as unknown as Record<string, unknown>
  function check(value: unknown) {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.$ref === 'string') {
      assert.ok(record.$ref.startsWith('#/'), record.$ref)
      let target: unknown = document
      for (const segment of record.$ref.slice(2).split('/')) target = (target as Record<string, unknown>)?.[segment]
      assert.ok(target, record.$ref)
    }
    for (const child of Object.values(record)) check(child)
  }
  check(document)
  assert.match(paths['/api/rounds/{roundId}/settlement'].get.description, /본인이 지급할 수취인의 최신 계좌/)
  assert.match(paths['/api/rounds/{roundId}/settlement'].get.description, /USD·JPY와 수취 내역에는 계좌 필드가 없습니다/)
  assert.match(paths['/api/rounds/{roundId}/settlement'].get.description, /각 수취 건의 확인 시각/)
  assert.ok((openApiDocument.components.schemas.Settlement as DocumentedSchema).required?.includes('confirmations'))
  assert.deepEqual((openApiDocument.components.schemas.SettlementConfirmation as DocumentedSchema).required, ['userId', 'displayName', 'profileImageUrl', 'checkedAt'])
  assert.ok((openApiDocument.components.schemas.IncomingTransfer as DocumentedSchema).required?.includes('receivedAt'))
  const checkInput = paths['/api/rounds/{roundId}/settlement-check'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.deepEqual(checkInput.required, ['expectedVersion', 'checked'])
  assert.ok(checkInput.properties?.senderId)
  assert.match(paths['/api/auth/withdraw'].post.description, /deletedAt/)
  assert.match(paths['/api/rounds/{roundId}/send'].post.description, /실제 메시지를 전송하지 않습니다/)
  assert.equal(openApiDocument.components.schemas.MinorAmount.type, 'string')
  assert.deepEqual(openApiDocument.components.schemas.Currency.enum, ['KRW', 'JPY', 'USD'])
})

test('currency is required on round creation and absent from groups and invitation previews', () => {
  const groupInput = paths['/api/groups'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.deepEqual(groupInput.required, ['name'])
  assert.deepEqual(Object.keys(groupInput.properties!), ['name'])
  assert.equal(groupInput.additionalProperties, false)

  const roundInput = paths['/api/groups/{groupId}/rounds'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.deepEqual(roundInput.required, ['name', 'currency', 'participantIds'])
  assert.deepEqual(roundInput.properties!.currency.enum, ['KRW', 'JPY', 'USD'])
  assert.equal(roundInput.additionalProperties, false)
  assert.match(paths['/api/groups/{groupId}/rounds'].post.description, /같은 모임에서도 회차마다 다른 통화/)
  assert.match(paths['/api/groups/{groupId}/rounds'].post.description, /생성 후 통화는 변경할 수 없고 과거 회차의 통화는 보존/)

  for (const name of ['Group', 'GroupDetail'] as const) {
    const schema = openApiDocument.components.schemas[name] as DocumentedSchema
    assert.equal('currency' in schema.properties!, false)
  }
  const preview = paths['/api/invites/{token}'].get.responses['200'] as { content: Record<string, { schema: DocumentedSchema }> }
  assert.equal('currency' in preview.content['application/json'].schema.properties!.data.properties!, false)
  assert.equal((openApiDocument.components.schemas.GroupDetail as DocumentedSchema).properties!.members.maxItems, 10)
  assert.equal(roundInput.properties!.participantIds.maxItems, 10)
  assert.match(paths['/api/invites/{token}/accept'].post.description, /group_member_limit_exceeded/)
  const round = openApiDocument.components.schemas.Round as DocumentedSchema
  assert.deepEqual(round.properties!.currency.enum, ['KRW', 'JPY', 'USD'])
})

test('round lists document group and round name search', () => {
  for (const path of ['/api/rounds', '/api/groups/{groupId}/rounds']) {
    const search = paths[path].get.parameters?.find(parameter => parameter.name === 'q') as { schema?: { minLength?: number; maxLength?: number } } | undefined
    assert.deepEqual(search?.schema, { type: 'string', minLength: 1, maxLength: 100 })
  }
})
