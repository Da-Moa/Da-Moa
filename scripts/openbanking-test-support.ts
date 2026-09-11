import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AccessToken } from '../src/lib/auth.ts'
import { completeOnboarding, updateBankAccount } from '../src/lib/auth-store.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { completeOpenBanking, retryDisconnect, startOpenBanking } from '../src/lib/openbanking-store.ts'

// Controlled provider responses for isolated DB tests. Application code always uses the real HTTPS client.
export function installOpenBankingFixture() {
  const database = new URL(process.env.TEST_DATABASE_URL ?? 'http://invalid')
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && database.pathname.includes('test'))
  Object.assign(process.env, {
    OPENBANKING_ENV: 'test', OPENBANKING_CLIENT_ID: 'isolated-test-client', OPENBANKING_CLIENT_SECRET: 'isolated-test-secret',
    OPENBANKING_CLIENT_USE_CODE: 'T123456789', OPENBANKING_REDIRECT_URI: 'http://localhost:3087/auth/v1/openbanking',
    OPENBANKING_SCOPES: 'login inquiry', OPENBANKING_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64'),
    OPENBANKING_REQUEST_HMAC_KEY: Buffer.alloc(32, 32).toString('base64'),
  })
  const holders = new Map<string, string>()
  const subjects = new Map<string, string>()
  const calls: Array<{ path: string; body: Record<string, string> }> = []
  let sequence = 1000000000
  const original = globalThis.fetch
  const provider: typeof fetch = async (url, options) => {
    const endpoint = new URL(String(url))
    assert.equal(endpoint.origin, 'https://testapi.openbanking.or.kr', 'tests never call an external service')
    const body = options?.body instanceof URLSearchParams ? Object.fromEntries(options.body) : JSON.parse(String(options?.body ?? '{}'))
    calls.push({ path: endpoint.pathname, body })
    if (endpoint.pathname === '/oauth/2.0/token') {
      const service = body.grant_type === 'client_credentials'
      const subject = subjects.get(body.code) ?? subjects.get(body.refresh_token) ?? String(++sequence)
      const refreshToken = `refresh-${randomUUID()}`
      subjects.set(refreshToken, subject)
      return Response.json({ token_type: 'Bearer', access_token: `access-${randomUUID()}`, expires_in: 3600,
        scope: service ? 'oob' : 'login inquiry', ...(service ? { client_use_code: 'T123456789' } : { user_seq_no: subject, refresh_token: refreshToken }) })
    }
    if (endpoint.pathname === '/v2.0/inquiry/real_name') {
      assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization?.startsWith('Bearer '), true)
      assert.equal(body.account_holder_info_type, ' ')
      assert.match(body.account_holder_info, /^\d{6}$/)
      return Response.json({ ...body, rsp_code: 'A0000', bank_rsp_code: '000', account_holder_name: holders.get(body.account_num) ?? '확인 실패' })
    }
    if (endpoint.pathname === '/v2.0/user/close') return Response.json({ rsp_code: 'A0000' })
    throw new Error(`Unexpected provider endpoint: ${endpoint.pathname}`)
  }
  globalThis.fetch = provider
  return {
    calls, provider,
    restore: () => { globalThis.fetch = original },
    bank(accountHolder: string, accountNumber = '00123456789', expectedBankVersion = 0) {
      holders.set(accountNumber.replace(/[ -]/g, ''), accountHolder.trim().normalize('NFC'))
      return { bankCode: '004', accountNumber, accountHolder, birthDate: '1990-01-01', expectedBankVersion }
    },
    async authorize(access: AccessToken) {
      const account = await getAccount(access, true)
      const begin = await startOpenBanking(access, account.purpose === 'onboarding' ? 'onboarding' : 'settings', '/home')
      if (!begin.authorizationUrl) return
      const state = new URL(begin.authorizationUrl).searchParams.get('state')!
      const code = randomUUID()
      const existing = subjects.get(access.userId) ?? String(++sequence)
      subjects.set(access.userId, existing); subjects.set(code, existing)
      const completed = await completeOpenBanking(access, state, { code })
      assert.equal(completed.error, undefined)
    },
  }
}

type LegacyBankFixture = { bankName: string; accountHolder: string; accountNumber: string; confirmRejoin?: boolean }
let fixture: ReturnType<typeof installOpenBankingFixture> | undefined
const updateVersions = new Map<string, number>()
function fixtures() { return fixture ??= installOpenBankingFixture() }

// Existing settlement tests seed members through the real onboarding code and a controlled provider.
export async function completeTestOnboarding(access: AccessToken | null, bank: LegacyBankFixture) {
  const f = fixtures()
  const account = await getAccount(access, true)
  const input = { ...f.bank(bank.accountHolder, bank.accountNumber, account.bankVersion), confirmRejoin: bank.confirmRejoin ?? false }
  if (account.deletedAt !== null && !bank.confirmRejoin) return completeOnboarding(access, input)
  await retryDisconnect(account.id)
  await f.authorize(access!)
  return completeOnboarding(access, input)
}

export async function updateTestBankAccount(access: AccessToken | null, key: string, bank: LegacyBankFixture) {
  const f = fixtures()
  const account = await getAccount(access)
  const versionKey = `${account.id}:${key}`
  if (!updateVersions.has(versionKey)) updateVersions.set(versionKey, account.bankVersion)
  return updateBankAccount(access, key, f.bank(bank.accountHolder, bank.accountNumber, updateVersions.get(versionKey)))
}
