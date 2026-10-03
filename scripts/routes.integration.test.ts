import { uuidV7 } from '../src/lib/uuid.ts'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest } from 'next/server'
import sharp from 'sharp'
import { readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/Global/Auth/Backend/index.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { CURRENCY_CODES } from '../src/lib/money.ts'
import { GET as dispatch } from '../src/app/api/[...path]/route.ts'
import { GET as me } from '../src/app/api/me/route.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding as completeOnboarding } from './bank-test-support.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const origin = 'http://localhost:3087'

async function session(name: string) {
  const signup = await signInKakao(`routes-test:${randomUUID()}`, { displayName: name, email: null, profileImageUrl: null })
  return completeOnboarding(readAccessToken(signup.accessToken), { bankName: '검증은행', accountNumber: '12340312345678', accountHolder: name })
}

async function request(path: string, token: string | null, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>) {
  const headers = new Headers({ origin, ...extraHeaders })
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (method !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', path === 'groups' && method === 'POST' ? uuidV7() : randomUUID())
  const multipart = body instanceof FormData
  if (body !== undefined && !multipart) headers.set('content-type', 'application/json')
  const req = new NextRequest(`${origin}/api/${path}`, { method, headers, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) })
  const response = await dispatch(req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) })
  return response
}

test('Route Handler contracts enforce Bearer JWTs, origin, idempotency, normalized images and personalized output', async () => {
  const client = createDatabaseClient(testUrl)
  await client.connect()
  try {
    await applyMigrations(client)
    const a = await session('API-A'), b = await session('API-B'), outsider = await session('API-외부인')
    assert.equal((await request('groups', null)).status, 401)
    assert.equal((await request('groups', a.accessToken, 'POST', { name: '금지' }, { origin: 'https://attacker.example' })).status, 403)
    const account = await me(new NextRequest(`${origin}/api/me`, { headers: { authorization: `Bearer ${a.accessToken}` } }))
    assert.equal(account.headers.get('cache-control'), 'private, no-store')
    assert.equal((await account.json()).data.bankAccount.accountNumber, '12340312345678')
    const groupResult = await request('groups', a.accessToken, 'POST', { name: 'HTTP 계약' })
    assert.equal(groupResult.status, 200, await groupResult.clone().text())
    const groupId = (await groupResult.json()).data.id
    const emptyGroup = await request('groups', a.accessToken, 'POST', { name: '삭제 API 계약' })
    const emptyGroupId = (await emptyGroup.json()).data.id
    assert.equal((await request(`groups/${emptyGroupId}`, a.accessToken, 'DELETE')).status, 200)
    assert.equal((await request(`groups/${emptyGroupId}`, a.accessToken)).status, 404)
    const detail = (await (await request(`groups/${groupId}`, a.accessToken)).json()).data
    assert.equal('currency' in detail, false)
    assert.deepEqual(detail.members, [{ userId: a.userId, displayName: 'API-A', excludedAt: null }])
    assert.equal(detail.isCreator, true)
    assert.equal((await request(`groups/${groupId}`, null)).status, 401)
    assert.equal((await request(`groups/${groupId}`, outsider.accessToken)).status, 404)
    assert.equal((await request(`groups/${groupId}/members`, a.accessToken)).status, 404)
    const invite = (await (await request(`groups/${groupId}/invites`, a.accessToken, 'POST', {})).json()).data
    const token = invite.sharePath.split('/').at(-1)
    const preview = (await (await request(`invites/${token}`, b.accessToken)).json()).data
    assert.equal(preview.isMember, false)
    assert.equal('currency' in preview, false)
    assert.equal((await request(`invites/${token}/accept`, b.accessToken, 'POST')).status, 200)
    const participantDetail = (await (await request(`groups/${groupId}`, b.accessToken)).json()).data
    assert.deepEqual(participantDetail.members.map((member: { userId: string }) => member.userId), [a.userId, b.userId])
    assert.equal(participantDetail.isCreator, false)
    assert.deepEqual(participantDetail.invites, [])
    for (const currency of [undefined, 'XXX']) {
      const rejected = await request(`groups/${groupId}/rounds`, a.accessToken, 'POST', { name: '통화 필요', participantIds: [a.userId, b.userId], ...(currency === undefined ? {} : { currency }) })
      assert.equal(rejected.status, 400)
      assert.equal((await rejected.json()).error, 'unsupported_currency')
    }
    const memberCreated = await request(`groups/${groupId}/rounds`, b.accessToken, 'POST', { name: '참여자가 만든 회차', currency: 'KRW', participantIds: [a.userId, b.userId] })
    assert.equal(memberCreated.status, 200)
    const memberRoundId = (await memberCreated.json()).data.id
    const memberRound = (await (await request(`rounds/${memberRoundId}`, b.accessToken)).json()).data
    assert.equal(memberRound.creatorId, b.userId)
    assert.equal(memberRound.groupCreatorId, a.userId)
    assert.equal(memberRound.isCreator, true)
    assert.equal((await request(`rounds/${memberRoundId}`, b.accessToken, 'DELETE', { expectedVersion: 1 })).status, 200)
    const created = await request(`groups/${groupId}/rounds`, a.accessToken, 'POST', { name: 'API 회차', currency: 'KRW', participantIds: [a.userId, b.userId] })
    assert.equal(created.status, 200)
    const roundId = (await created.json()).data.id
    for (const currency of CURRENCY_CODES) {
      const foreign = await request(`groups/${groupId}/rounds`, a.accessToken, 'POST', { name: `${currency} API 회차`, currency, participantIds: [a.userId, b.userId] })
      assert.equal(foreign.status, 200)
      const foreignId = (await foreign.json()).data.id
      const saved = await request(`rounds/${foreignId}/expenses`, a.accessToken, 'POST', { description: '회차 통화', amount: ['KRW', 'JPY', 'VND'].includes(currency) ? '1025' : '10.25', payerId: b.userId, splitMode: 'ALL', expectedVersion: 1 })
      assert.equal(saved.status, 200)
      const current = (await (await request(`rounds/${foreignId}`, a.accessToken)).json()).data
      assert.equal(current.groupId, groupId)
      assert.equal(current.currency, currency)
      assert.equal(current.expenses[0].amountMinor, '1025')
    }
    assert.equal((await (await request(`rounds/${roundId}`, a.accessToken)).json()).data.currency, 'KRW')
    const customRound = (await (await request(`groups/${groupId}/rounds`, a.accessToken, 'POST', { name: '개별 부담 API', currency: 'USD', participantIds: [a.userId, b.userId] })).json()).data
    const customBody = { description: '개별 지출', amount: '0.30', payerId: b.userId, splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '0.10' }, { userId: b.userId, amount: '0.20' }], expectedVersion: 1 }
    const mismatch = await request(`rounds/${customRound.id}/expenses`, a.accessToken, 'POST', { ...customBody, amount: '0.31' })
    assert.equal(mismatch.status, 400)
    assert.deepEqual(await mismatch.json(), { error: 'custom_share_total_mismatch', message: '부담금 합계가 총 금액과 일치해야 해요' })
    const customSave = await request(`rounds/${customRound.id}/expenses`, a.accessToken, 'POST', customBody)
    assert.equal(customSave.status, 200, await customSave.clone().text())
    const customExpense = (await customSave.json()).data
    const customPatch = await request(`rounds/${customRound.id}/expenses/${customExpense.id}`, a.accessToken, 'PATCH', { amount: '0.40', expectedVersion: customExpense.version })
    assert.equal(customPatch.status, 400)
    assert.equal((await customPatch.json()).error, 'custom_share_total_mismatch')
    const customDetail = (await (await request(`rounds/${customRound.id}`, a.accessToken)).json()).data
    assert.equal(customDetail.version, customExpense.version)
    assert.equal(customDetail.expenses[0].amountMinor, '30')
    assert.deepEqual(Object.fromEntries(customDetail.expenses[0].shares.map((share: { userId: string; assignedAmountMinor: string }) => [share.userId, share.assignedAmountMinor])), { [a.userId]: '10', [b.userId]: '20' })
    assert.ok(customDetail.expenses[0].shares.every((share: { amountMinor: string | null }) => share.amountMinor === null))
    const absent = await request(`rounds/${roundId}`, outsider.accessToken)
    assert.equal(absent.status, 404)
    assert.equal((await request(`rounds/${roundId}/confirm`, a.accessToken, 'POST', { expectedVersion: 1 })).status, 409)
    const invalid = await request(`rounds/${roundId}/expenses`, a.accessToken, 'POST', { description: '잘못된금액', amount: 6000, payerId: b.userId, splitMode: 'ALL', expectedVersion: 1 })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, 'invalid_amount')
    const requestKey = randomUUID(), expenseBody = { description: '식사', amount: '6000', payerId: b.userId, splitMode: 'ALL', expectedVersion: 1 }
    const save = await request(`rounds/${roundId}/expenses`, a.accessToken, 'POST', expenseBody, { 'Idempotency-Key': requestKey })
    const e = (await save.json()).data
    const replay = await request(`rounds/${roundId}/expenses`, a.accessToken, 'POST', expenseBody, { 'Idempotency-Key': requestKey })
    assert.deepEqual((await replay.json()).data, e)
    assert.equal((await request(`rounds/${roundId}/expenses/${e.id}/receipts`, null, 'POST', {})).status, 401)
    const form = new FormData()
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#369' } }).png().toBuffer()
    form.set('file', new File([png], 'receipt.png', { type: 'image/png' }))
    form.set('expectedVersion', String(e.version))
    const uploaded = await request(`rounds/${roundId}/expenses/${e.id}/receipts`, a.accessToken, 'POST', form)
    assert.equal(uploaded.status, 200)
    const receipt = (await uploaded.json()).data
    const binary = await request(`receipts/${receipt.id}`, b.accessToken)
    assert.equal(binary.headers.get('content-type'), 'image/avif')
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(binary.headers.get('cache-control'), 'private, no-store')
    const converted = Buffer.from(await binary.arrayBuffer())
    assert.equal((await sharp(converted).metadata()).mediaType, 'image/avif')
    assert.notDeepEqual(converted, png)
    assert.equal((await request(`receipts/${receipt.id}`, outsider.accessToken)).status, 404)
    const largePng = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
    assert.ok(largePng.length > 2097152)
    const largeForm = new FormData()
    largeForm.set('file', new File([largePng], 'large.png', { type: 'image/png' }))
    largeForm.set('expectedVersion', String(receipt.version))
    const largeUpload = await request(`rounds/${roundId}/expenses/${e.id}/receipts`, a.accessToken, 'POST', largeForm)
    assert.equal(largeUpload.status, 200, await largeUpload.clone().text())
    const largeReceipt = (await largeUpload.json()).data
    const largeBinary = await request(`receipts/${largeReceipt.id}`, b.accessToken)
    assert.equal(largeBinary.headers.get('content-type'), 'image/avif')
    assert.equal((await sharp(await largeBinary.arrayBuffer()).metadata()).mediaType, 'image/avif')
    const confirmed = (await (await request(`rounds/${roundId}/confirm`, a.accessToken, 'POST', { expectedVersion: largeReceipt.version })).json()).data
    const sent = await request(`rounds/${roundId}/send`, a.accessToken, 'POST', { expectedVersion: confirmed.version })
    assert.equal(sent.status, 200)
    const locked = (await sent.json()).data
    const settlement = await request(`rounds/${roundId}/settlement?userId=${b.userId}`, a.accessToken)
    assert.equal(settlement.headers.get('cache-control'), 'private, no-store')
    const result = (await settlement.json()).data
    assert.equal(result.balanceMinor, '3000')
    assert.equal(result.outgoing[0].receiverId, b.userId)
    assert.equal(result.outgoing[0].account.accountNumber, '12340312345678')
    assert.equal(result.incoming.length, 0)
    assert.equal(result.sharePath, `/settlements/${roundId}`)
    assert.equal((await request(`rounds/${roundId}/settlement-check`, a.accessToken, 'POST', { expectedVersion: locked.version, checked: 'yes' })).status, 400)
    assert.equal((await request(`rounds/${roundId}/settlement-check`, a.accessToken, 'POST', { expectedVersion: locked.version, checked: true })).status, 403)
    assert.equal((await request(`rounds/${roundId}/settlement-check`, b.accessToken, 'POST', { expectedVersion: locked.version, checked: true, senderId: a.userId })).status, 200)
    const checked = (await (await request(`rounds/${roundId}/settlement`, a.accessToken)).json()).data
    assert.deepEqual({ checkedCount: checked.checkedCount, requiredCount: checked.requiredCount, allChecked: checked.allChecked }, { checkedCount: 1, requiredCount: 1, allChecked: true })
    assert.equal((await request(`rounds/${roundId}/complete`, a.accessToken, 'POST', { expectedVersion: locked.version })).status, 200)
    assert.equal((await request('unknown/endpoint', a.accessToken)).status, 404)
  } finally { await client.end() }
})
