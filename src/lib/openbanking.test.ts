import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBankAccountInput } from './bank-account.ts'
import { AppError } from './errors.ts'
import { bankAccountRequestFingerprint, createOpenBankingAuthorizationUrl, decryptOpenBankingSecret, disconnectOpenBankingUser, encryptOpenBankingSecret, exchangeOpenBankingCode, getOpenBankingConfig, inquireRealName, issueOpenBankingServiceToken, listOpenBankingAccounts, OpenBankingError, refreshOpenBankingToken } from './openbanking.ts'

const raw = { bankCode: '004', accountNumber: '001- 2345678', birthDate: '2000-02-29', accountHolder: ' 홍길동 ', expectedBankVersion: 0 }
const input = normalizeBankAccountInput(raw)
const tranId = 'M202600001U000000001'

const config = {
  OPENBANKING_ENV: 'test', OPENBANKING_CLIENT_ID: 'test-client', OPENBANKING_CLIENT_SECRET: 'test-client-secret',
  OPENBANKING_CLIENT_USE_CODE: 'M202600001', OPENBANKING_REDIRECT_URI: 'http://localhost:3000/auth/v1/openbanking',
  OPENBANKING_SCOPES: 'login inquiry', OPENBANKING_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  OPENBANKING_REQUEST_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
}

async function withConfig(run: () => unknown): Promise<void> {
  const previous = { ...process.env }
  Object.assign(process.env, config)
  delete process.env.OPENBANKING_API_BASE_URL
  delete process.env.OPENBANKING_AUTHORIZE_URL
  delete process.env.OPENBANKING_TOKEN_URL
  try { await run() } finally { process.env = previous }
}

function realNameResponse(overrides: Record<string, unknown> = {}) {
  return { rsp_code: 'A0000', bank_rsp_code: '000', bank_tran_id: tranId, bank_code_std: input.bankCode, account_num: input.accountNumber, account_holder_info_type: ' ', account_holder_info: '000229', account_holder_name: '홍길동', ...overrides }
}

function registeredAccount(overrides: Record<string, unknown> = {}) {
  return { fintech_use_num: '123456789012345678901234', bank_code_std: '004', account_holder_name: ' 홍길동 ', account_num_masked: '001-2345-***', account_state: '01', inquiry_agree_yn: 'Y', account_holder_type: 'P', ...overrides }
}

function registeredAccountsResponse(rows: Record<string, unknown>[]) {
  return { rsp_code: 'A0000', res_cnt: String(rows.length), res_list: rows }
}

test('bank input preserves zeroes, validates real dates, and refuses client verification fields', () => {
  assert.equal(input.accountNumber, '0012345678')
  assert.equal(input.accountHolder, '홍길동')
  assert.equal(input.bankName, 'KB국민은행')
  for (const fields of [
    { birthDate: '2001-02-29' }, { birthDate: '2020-13-01' }, { birthDate: '9999-01-01' },
    { bankCode: '999' }, { bankCode: '097' }, { accountNumber: '１２３' }, { accountNumber: '1\n2' },
    { expectedBankVersion: -1 }, { expectedBankVersion: '0' }, { verified: true }, { bankName: '가짜은행' },
  ]) assert.throws(() => normalizeBankAccountInput({ ...raw, ...fields }), error => error instanceof AppError && error.code === 'invalid_input')
  assert.equal(normalizeBankAccountInput({ ...raw, bankCode: '097' }, { allowTestBanks: true }).bankCode, '097')
  assert.throws(() => normalizeBankAccountInput({ ...raw, confirmRejoin: true }))
  assert.equal(normalizeBankAccountInput({ ...raw, confirmRejoin: true }, { onboarding: true }).confirmRejoin, true)
  assert.equal(normalizeBankAccountInput({ ...raw, accountHolder: '홍길동'.normalize('NFD') }).accountHolder, '홍길동')
})

test('unverified saves omit birth date and need no open banking keys for their mode-bound fingerprint', () => withConfig(async () => {
  const { birthDate: omitted, ...withoutBirthDate } = raw
  const basic = normalizeBankAccountInput({ ...withoutBirthDate, verifyWithOpenBanking: false })
  assert.equal(basic.birthDate, '')
  assert.equal(basic.verifyWithOpenBanking, false)
  assert.equal(input.verifyWithOpenBanking, true, 'the omitted flag preserves verification for existing requests')
  assert.throws(() => normalizeBankAccountInput(withoutBirthDate), AppError)
  assert.throws(() => normalizeBankAccountInput({ ...raw, verifyWithOpenBanking: false }), AppError)
  assert.throws(() => normalizeBankAccountInput({ ...withoutBirthDate, verifyWithOpenBanking: 'false' }), AppError)
  process.env.AUTH_JWT_SECRET = 'manual-bank-fingerprint-secret-at-least-32-bytes'
  const verifiedFingerprint = bankAccountRequestFingerprint('member', input)
  const fingerprint = bankAccountRequestFingerprint('member', basic)
  assert.notEqual(fingerprint, verifiedFingerprint)
  for (const name of Object.keys(process.env).filter(name => name.startsWith('OPENBANKING_'))) delete process.env[name]
  assert.equal(bankAccountRequestFingerprint('member', basic), fingerprint)
  assert.notEqual(bankAccountRequestFingerprint('other', basic), fingerprint)
  assert.notEqual(bankAccountRequestFingerprint('member', { ...basic, accountNumber: '009999' }), fingerprint)
  await assert.rejects(inquireRealName(basic, 'unused', tranId), error => error instanceof AppError && error.code === 'invalid_input')
}))

test('configuration fixes provider destinations and uses exactly 32-byte OAuth state', () => withConfig(() => {
  const url = new URL(createOpenBankingAuthorizationUrl('a'.repeat(32)))
  assert.equal(url.origin, 'https://testapi.openbanking.or.kr')
  assert.equal(url.pathname, '/oauth/2.0/authorize')
  assert.equal(url.searchParams.get('auth_type'), '0')
  assert.equal(url.searchParams.get('scope'), 'login inquiry')
  assert.equal(url.searchParams.has('client_secret'), false)
  assert.throws(() => createOpenBankingAuthorizationUrl('a'.repeat(43)))
  process.env.OPENBANKING_TOKEN_URL = 'https://elsewhere.example/token'
  assert.throws(getOpenBankingConfig)
  delete process.env.OPENBANKING_TOKEN_URL
  process.env.OPENBANKING_ENV = 'production'
  assert.throws(getOpenBankingConfig) // A production callback must use HTTPS.
}))

test('authenticated encryption rejects wrong owner, altered ciphertext, and key reuse', () => withConfig(() => {
  const encrypted = encryptOpenBankingSecret('private-token', 'user:a:connection:a:access')
  assert.equal(encrypted.includes('private-token'), false)
  assert.equal(decryptOpenBankingSecret(encrypted, 'user:a:connection:a:access'), 'private-token')
  assert.throws(() => decryptOpenBankingSecret(encrypted, 'user:b:connection:a:access'), OpenBankingError)
  const pieces = encrypted.split('.')
  pieces[3] = Buffer.from('tampered').toString('base64url')
  assert.throws(() => decryptOpenBankingSecret(pieces.join('.'), 'user:a:connection:a:access'), OpenBankingError)
  const fingerprint = bankAccountRequestFingerprint('member', input)
  assert.equal(fingerprint, bankAccountRequestFingerprint('member', { ...input }))
  assert.notEqual(fingerprint, bankAccountRequestFingerprint('other', input))
  assert.notEqual(fingerprint, bankAccountRequestFingerprint('member', { ...input, birthDate: '2000-02-28' }))
  process.env.OPENBANKING_REQUEST_HMAC_KEY = process.env.OPENBANKING_TOKEN_ENCRYPTION_KEY
  assert.throws(() => bankAccountRequestFingerprint('member', input), OpenBankingError)
}))

test('real OAuth requests separate institution and user grants and preserve refresh scope', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  const grants: string[] = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://testapi.openbanking.or.kr/oauth/2.0/token')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    const body = init!.body as URLSearchParams
    const grant = body.get('grant_type')!
    grants.push(grant)
    assert.equal(body.get('client_secret'), config.OPENBANKING_CLIENT_SECRET)
    if (grant === 'client_credentials') {
      assert.equal(body.get('scope'), 'oob')
      return Response.json({ access_token: 'institution-token', token_type: 'Bearer', expires_in: 3600, scope: 'oob', client_use_code: config.OPENBANKING_CLIENT_USE_CODE })
    }
    if (grant === 'refresh_token') assert.equal(body.get('scope'), 'login inquiry')
    if (grant === 'authorization_code') assert.equal(body.get('redirect_uri'), config.OPENBANKING_REDIRECT_URI)
    return Response.json({ access_token: 'user-token', refresh_token: 'user-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'login inquiry', user_seq_no: '1000000001' })
  }
  try {
    const user = await exchangeOpenBankingCode('auth-code')
    assert.equal(user.userSeqNo, '1000000001')
    assert.equal(user.refreshExpiresAt! - user.expiresAt, 10 * 86400)
    assert.equal((await refreshOpenBankingToken('user-refresh', 'login inquiry')).refreshToken, 'user-refresh')
    assert.equal((await issueOpenBankingServiceToken()).userSeqNo, null)
    assert.deepEqual(grants, ['authorization_code', 'refresh_token', 'client_credentials'])
  } finally { globalThis.fetch = originalFetch }
}))

test('registered accounts use the user grant and leave missing full numbers for manual input', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  let rows = [registeredAccount()]
  globalThis.fetch = async (value, init) => {
    const url = new URL(String(value))
    assert.equal(url.origin, 'https://testapi.openbanking.or.kr')
    assert.equal(url.pathname, '/v2.0/account/list')
    assert.deepEqual(Object.fromEntries(url.searchParams), { user_seq_no: '1000000001', include_cancel_yn: 'N', sort_order: 'D' })
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer user-token')
    assert.equal(init?.body, undefined)
    assert.equal(init?.cache, 'no-store')
    return Response.json(registeredAccountsResponse(rows))
  }
  try {
    const masked = await listOpenBankingAccounts('user-token', '1000000001')
    assert.deepEqual(masked, [{ fintechUseNum: '123456789012345678901234', bankCode: '004', bankName: 'KB국민은행', accountHolder: '홍길동', accountNumber: null, accountNumberMasked: '001-2345-***' }])
    assert.equal('birthDate' in masked[0], false)
    assert.equal('verifiedAt' in masked[0], false)
    rows = [registeredAccount({ account_num: '0012345678', account_holder_name: '홍길동'.normalize('NFD') })]
    const full = await listOpenBankingAccounts('user-token', '1000000001')
    assert.equal(full[0].accountNumber, '0012345678')
    assert.equal(full[0].accountHolder, '홍길동')
    for (const account_num of [null, '', undefined]) {
      rows = [registeredAccount({ account_num })]
      assert.equal((await listOpenBankingAccounts('user-token', '1000000001'))[0].accountNumber, null)
    }
    rows = []
    assert.deepEqual(await listOpenBankingAccounts('user-token', '1000000001'), [])
  } finally { globalThis.fetch = originalFetch }
}))

test('registered account suggestions exclude closed, unconsented, nonpersonal and unsupported accounts', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(registeredAccountsResponse([
    registeredAccount({ account_state: '09' }), registeredAccount({ inquiry_agree_yn: 'N' }),
    registeredAccount({ account_holder_type: 'B' }), registeredAccount({ bank_code_std: '999' }),
    registeredAccount({ bank_code_std: '097' }),
  ]))
  try {
    assert.equal((await listOpenBankingAccounts('user-token', '1000000001'))[0].bankCode, '097')
    process.env.OPENBANKING_ENV = 'production'
    process.env.OPENBANKING_REDIRECT_URI = 'https://app.example/auth/v1/openbanking'
    assert.deepEqual(await listOpenBankingAccounts('user-token', '1000000001'), [])
  } finally { globalThis.fetch = originalFetch }
}))

test('registered account parsing rejects malformed data and propagates user-token expiration without leaking data', () => withConfig(async () => {
  const originalFetch = globalThis.fetch, originalError = console.error
  const logs: unknown[][] = []
  let response: Record<string, unknown> = registeredAccountsResponse([registeredAccount()])
  globalThis.fetch = async () => Response.json(response)
  console.error = (...values) => { logs.push(values) }
  try {
    const invalidResponses = [
      { rsp_code: 'A0000', res_cnt: '1', res_list: [] }, { rsp_code: 'A0000', res_cnt: '0', res_list: null },
      { rsp_code: 'A0000', res_cnt: '0junk', res_list: [] }, { rsp_code: 'A0000', res_cnt: '1', res_list: [null] },
      registeredAccountsResponse([registeredAccount(), registeredAccount()]),
      ...[
        { fintech_use_num: 'not-a-fintech-id' }, { account_num: '0012345***' }, { account_num: 12345678 },
        { account_num: '00123456789012345' }, { account_num_masked: '<script>' },
        { account_holder_name: '' }, { account_holder_name: '홍\n길동' }, { account_holder_name: '가'.repeat(41) },
        { account_state: undefined }, { inquiry_agree_yn: undefined }, { bank_code_std: 4 },
      ].map(fields => registeredAccountsResponse([registeredAccount(fields)])),
    ]
    for (response of invalidResponses) await assert.rejects(listOpenBankingAccounts('user-token', '1000000001'), error => error instanceof OpenBankingError && error.kind === 'unknown')
    response = { rsp_code: 'A0003', rsp_message: '홍길동 0012345678 private-user-token' }
    await assert.rejects(listOpenBankingAccounts('user-token', '1000000001'), OpenBankingError)
    response = { rsp_code: 'O0003' }
    await assert.rejects(listOpenBankingAccounts('user-token', '1000000001'), error => error instanceof OpenBankingError && error.reauth)
    const output = JSON.stringify(logs)
    for (const secret of ['홍길동', '0012345678', '1000000001', 'private-user-token', '123456789012345678901234']) assert.ok(!output.includes(secret))
  } finally { globalThis.fetch = originalFetch; console.error = originalError }
}))

test('real-name verification sends DOB as SPACE/YYMMDD and rejects failed or mismatched results', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  let response = realNameResponse()
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://testapi.openbanking.or.kr/v2.0/inquiry/real_name')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer institution-token')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.account_holder_info_type, ' ')
    assert.equal(body.account_holder_info, '000229')
    assert.equal(body.account_num, '0012345678')
    assert.match(body.tran_dtime, /^\d{14}$/)
    assert.equal('account_holder_name' in body, false)
    return Response.json(response)
  }
  try {
    const verified = await inquireRealName(input, 'institution-token', tranId)
    assert.equal(verified.verificationTranId, tranId)
    assert.equal('birthDate' in verified, false)
    for (const override of [
      { bank_tran_id: 'M202600001U000000002' }, { bank_code_std: '020' }, { account_num: '12345678' },
      { account_holder_info: '000228' }, { account_holder_info_type: '1' }, { account_holder_name: '' },
    ]) {
      response = realNameResponse(override)
      await assert.rejects(inquireRealName(input, 'institution-token', tranId), OpenBankingError)
    }
    response = realNameResponse({ account_holder_name: '다른 사람' })
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), error => error instanceof AppError && error.code === 'account_holder_mismatch' && !error.message.includes('다른 사람'))
    for (const bank_rsp_code of ['412', '463', '465', '484']) {
      response = realNameResponse({ rsp_code: 'A0002', bank_rsp_code })
      await assert.rejects(inquireRealName(input, 'institution-token', tranId), error => error instanceof AppError && error.code === 'bank_account_unverified')
    }
    response = realNameResponse({ rsp_code: 'A0002', bank_rsp_code: '818' })
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), error => error instanceof AppError && error.status === 424 && error.code === 'openbanking_test_data_missing')
    response = realNameResponse({ rsp_code: 'A0321' })
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), error => error instanceof OpenBankingError && error.kind === 'configuration')
    response = realNameResponse({ rsp_code: 'O0003' })
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), error => error instanceof OpenBankingError && error.reauth)
  } finally { globalThis.fetch = originalFetch }
}))

test('withdrawal only accepts documented completion and preserves unknown remote outcomes', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  let response = { rsp_code: 'A0000' }
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://testapi.openbanking.or.kr/v2.0/user/close')
    assert.deepEqual(JSON.parse(String(init?.body)), { client_use_code: 'M202600001', user_seq_no: '1000000001' })
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer user-token')
    return Response.json(response)
  }
  try {
    const user = { accessToken: 'user-token', userSeqNo: '1000000001' }
    await disconnectOpenBankingUser(user)
    response = { rsp_code: 'A0014' }
    await disconnectOpenBankingUser(user)
    for (const rsp_code of ['A0337', 'A0003', 'A0019']) {
      response = { rsp_code }
      await assert.rejects(disconnectOpenBankingUser(user), OpenBankingError)
    }
    response = { rsp_code: 'A0007' }
    await assert.rejects(disconnectOpenBankingUser(user), error => error instanceof OpenBankingError && error.remoteOutcome === 'unknown' && !error.retryable)
    globalThis.fetch = async () => { throw new Error('network error with private details') }
    await assert.rejects(disconnectOpenBankingUser(user), error => error instanceof OpenBankingError && error.remoteOutcome === 'unknown' && !error.message.includes('private'))
  } finally { globalThis.fetch = originalFetch }
}))

test('institution token rejection never asks the member for a new OAuth grant', () => withConfig(async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ rsp_code: 'O0002' }, { status: 401 })
  try {
    await assert.rejects(issueOpenBankingServiceToken(), error => error instanceof OpenBankingError && error.status === 503 && error.code === 'openbanking_unavailable' && !error.reauth)
  } finally { globalThis.fetch = originalFetch }
}))

test('provider diagnostics contain only codes and field names, never financial data or credentials', () => withConfig(async () => {
  const originalFetch = globalThis.fetch, originalError = console.error
  const logs: unknown[][] = []
  console.error = (...values) => { logs.push(values) }
  try {
    globalThis.fetch = async () => Response.json({ rsp_code: 'A0321', rsp_message: `${input.accountNumber} ${input.accountHolder} 000229 institution-token` })
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), OpenBankingError)
    globalThis.fetch = async () => Response.json(realNameResponse({ account_holder_info_type: '' }))
    await assert.rejects(inquireRealName(input, 'institution-token', tranId), OpenBankingError)
    const output = JSON.stringify(logs)
    assert.ok(output.includes('A0321') && output.includes('account_holder_info_type'))
    for (const secret of [input.accountNumber, input.accountHolder, '000229', 'institution-token', tranId, config.OPENBANKING_CLIENT_SECRET]) assert.ok(!output.includes(secret))
  } finally { globalThis.fetch = originalFetch; console.error = originalError }
}))
