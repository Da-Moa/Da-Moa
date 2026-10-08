import assert from 'node:assert/strict'
import test from 'node:test'
import { CURRENCY_CODES } from '../../../shared/domain/settle/money.ts'
import { openApiDocument } from '../../global/util/openapi.ts'

test('OpenAPI document uses the Swagger UI-compatible 3.0 dialect', () => {
  assert.equal(openApiDocument.openapi, '3.0.3')
  assert.equal(JSON.stringify(openApiDocument).includes('"const"'), false)
})

test('OpenAPI documents a recoverable refresh failure', () => {
  const refresh = openApiDocument.paths['/api/auth/refresh'].post

  assert.equal(refresh.responses['503'].$ref, '#/components/responses/RefreshUnavailable')
  assert.equal(
    openApiDocument.components.responses.RefreshUnavailable.content['application/json'].example.error,
    'refresh_unavailable',
  )
  assert.match(
    openApiDocument.paths['/api/auth/logout'].post.description,
    /DB 세션을 사용하거나 Access JWT를 즉시 만료시키지/,
  )
  assert.deepEqual(openApiDocument.paths['/api/auth/logout'].post.security, [{ refreshCookie: [] }, { accessBearer: [] }])
  assert.ok(openApiDocument.paths['/api/auth/logout'].post.responses['401'])
})

type DocumentedOperation = {
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: { pattern?: string; format?: string } }>
  requestBody?: { content: Record<string, { schema: { required?: string[] } }> }
  responses: Record<string, unknown>
  description: string
}
type DocumentedSchema = {
  required?: string[]
  properties?: Record<string, DocumentedSchema>
  enum?: string[]
  format?: string
  nullable?: boolean
  additionalProperties?: boolean
  maxItems?: number
  items?: DocumentedSchema
  description?: string
}
const paths = openApiDocument.paths as unknown as Record<string, Record<string, DocumentedOperation> & {
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: { pattern?: string; format?: string } }>
}>

test('group creation requires a UUIDv7 key and token bootstrap requires Origin only', () => {
  const parameters = paths['/api/groups'].post.parameters ?? []
  const key = parameters.find(parameter => parameter.name === 'Idempotency-Key')
  assert.equal(key?.schema?.format, 'uuid')
  assert.match(key?.description ?? '', /UUIDv7/)
  assert.equal(parameters.find(parameter => parameter.name === 'Origin')?.schema?.format, 'uri')
  assert.deepEqual(openApiDocument.paths['/api/auth/access-token'].post.parameters.map(parameter => parameter.name), ['Origin'])
})

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
  function check(value: unknown, name?: string) {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (Array.isArray(record.required)) assert.ok(record.required.length, 'OpenAPI required arrays must not be empty')
    if (['createdAt', 'updatedAt', 'expiresAt'].includes(name ?? '')) {
      assert.equal(record.format, 'int64', `${name} must be a timestamp`)
      assert.notEqual(record.nullable, true, `${name} must not be nullable`)
    }
    if (typeof record.$ref === 'string') {
      assert.ok(record.$ref.startsWith('#/'), record.$ref)
      let target: unknown = document
      for (const segment of record.$ref.slice(2).split('/')) target = (target as Record<string, unknown>)?.[segment]
      assert.ok(target, record.$ref)
    }
    for (const [key, child] of Object.entries(record)) check(child, key)
  }
  check(document)
  assert.match(paths['/api/rounds/{roundId}/settlement'].get.description, /본인이 지급할 수취인의 최신 계좌/)
  assert.match(paths['/api/rounds/{roundId}/settlement'].get.description, /KRW 이외 통화와 수취 내역에는 계좌 필드가 없습니다/)
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
  assert.deepEqual(openApiDocument.components.schemas.Currency.enum, CURRENCY_CODES)
})

test('currency is required on expenses and absent on round creation and absent from groups and invitation previews', () => {
  const groupInput = paths['/api/groups'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.deepEqual(groupInput.required, ['name'])
  assert.deepEqual(Object.keys(groupInput.properties!), ['name'])
  assert.equal(groupInput.additionalProperties, false)

  const roundInput = paths['/api/groups/{groupId}/rounds'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.deepEqual(roundInput.required, ['name', 'participantIds'])
  assert.equal('currency' in roundInput.properties!, false)
  const expenseInput = paths['/api/rounds/{roundId}/expenses'].post.requestBody!.content['application/json'].schema as DocumentedSchema
  assert.ok(expenseInput.required?.includes('currency'))
  assert.deepEqual(expenseInput.properties!.currency.enum, CURRENCY_CODES)
  assert.equal(roundInput.additionalProperties, false)
  assert.match(paths['/api/groups/{groupId}/rounds'].post.description, /각 지출에서 지원 통화를 선택/)
  assert.match(paths['/api/groups/{groupId}/rounds'].post.description, /한 회차에 최대 5개 통화/)

  for (const name of ['Group', 'GroupDetail'] as const) {
    const schema = openApiDocument.components.schemas[name] as DocumentedSchema
    assert.equal('currency' in schema.properties!, false)
  }
  const preview = paths['/api/invites/{token}'].get.responses['200'] as { content: Record<string, { schema: DocumentedSchema }> }
  assert.equal('currency' in preview.content['application/json'].schema.properties!.data.properties!, false)
  assert.equal((openApiDocument.components.schemas.GroupDetail as DocumentedSchema).properties!.members.maxItems, 10)
  assert.equal('/api/groups/{groupId}/members' in paths, false)
  assert.equal(roundInput.properties!.participantIds.maxItems, 10)
  assert.match(paths['/api/invites/{token}/accept'].post.description, /group_member_limit_exceeded/)
  const round = openApiDocument.components.schemas.Round as DocumentedSchema
  assert.equal('currency' in round.properties!, false)
  assert.equal(round.properties!.totals.maxItems, 5)
})

test('round lists document group and round name search', () => {
  for (const path of ['/api/rounds', '/api/groups/{groupId}/rounds']) {
    const search = paths[path].get.parameters?.find(parameter => parameter.name === 'q') as { schema?: { minLength?: number; maxLength?: number } } | undefined
    assert.deepEqual(search?.schema, { type: 'string', minLength: 1, maxLength: 100 })
  }
})

test('group list documents name search with cursor pagination', () => {
  const parameters = paths['/api/groups'].get.parameters ?? []
  const search = parameters.find(parameter => parameter.name === 'q') as { schema?: { minLength?: number; maxLength?: number } } | undefined
  assert.deepEqual(search?.schema, { type: 'string', minLength: 1, maxLength: 100 })
  assert.match(parameters.find(parameter => parameter.name === 'cursor')?.description ?? '', /모임 ID 내림차순/)
  const listItem = openApiDocument.components.schemas.GroupListItem as DocumentedSchema
  assert.ok(listItem.required?.includes('memberCount'))
  assert.equal(listItem.properties?.memberPreview.maxItems, 5)
  assert.ok(listItem.properties?.memberPreview.items?.properties?.profileImageUrl)
})

test('custom expense allocation documents exact original shares and total validation', () => {
  for (const [path, method] of [['/api/rounds/{roundId}/expenses', 'post'], ['/api/rounds/{roundId}/expenses/{expenseId}', 'patch']]) {
    const input = paths[path][method].requestBody!.content['application/json'].schema as DocumentedSchema
    assert.deepEqual(input.properties!.splitMode.enum, ['ALL', 'SELECTED', 'CUSTOM'])
    assert.deepEqual(input.properties!.customShares.items!.required, ['userId', 'amount'])
    assert.match(input.properties!.customShares.description!, /합계는 총 amount와 같아야/)
    assert.match(input.properties!.participantIds.description!, /CUSTOM에서는 보내지/)
  }
  assert.match(paths['/api/rounds/{roundId}/expenses'].post.description, /400 custom_share_total_mismatch/)
  assert.match(paths['/api/rounds/{roundId}/expenses/{expenseId}'].patch.description, /customShares를 생략하면 원본 부담금을 유지/)
  const share = (openApiDocument.components.schemas.Expense as DocumentedSchema).properties!.shares.items!
  assert.ok(share.required!.includes('assignedAmountMinor'))
  assert.equal(share.properties!.assignedAmountMinor.nullable, true)
  assert.equal(share.properties!.amountMinor.nullable, true)
  assert.match(share.properties!.amountMinor.description!, /최종화 전에는 CUSTOM도 null/)
})
