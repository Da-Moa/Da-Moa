import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { BANKS, TEST_BANKS, normalizeAccountHolder, type BankAccountInput, type RegisteredBankAccount } from './bank-account.ts'
import { AppError } from './errors.ts'

// KFTC 이용기관 API 명세서 v3.3.6: §2.1, §2.2.3, §2.2.25, §2.4.1, §3.4–3.13.
// https://openapi.kftc.or.kr/support/mtrlDetail?bltn_seq_no=129
const TOKEN_GRACE_SECONDS = 10 * 24 * 60 * 60

export class OpenBankingError extends AppError {
  constructor(
    public readonly kind: 'configuration' | 'transient' | 'unknown' | 'reauth' | 'rejected',
    public readonly providerCode: string | null = null,
  ) {
    super(kind === 'reauth' ? 409 : 503, kind === 'reauth' ? 'openbanking_reauth_required' : 'openbanking_unavailable',
      kind === 'reauth' ? '금융결제원 인증을 다시 진행해 주세요' : '계좌 연결 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요')
    this.name = 'OpenBankingError'
  }
  get remoteOutcome(): 'unknown' | 'rejected' { return this.kind === 'unknown' ? 'unknown' : 'rejected' }
  get retryable(): boolean { return this.kind === 'transient' }
  get reauth(): boolean { return this.kind === 'reauth' }
}

function configurationError(): never { throw new OpenBankingError('configuration') }

function required(name: string, maxBytes = 2048): string {
  const value = process.env[name]?.trim()
  if (!value || Buffer.byteLength(value) > maxBytes) configurationError()
  return value
}

function secretKey(name: string): Buffer {
  const value = required(name)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) configurationError()
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) configurationError()
  return key
}

function validateKeys(): void {
  if (secretKey('OPENBANKING_TOKEN_ENCRYPTION_KEY').equals(secretKey('OPENBANKING_REQUEST_HMAC_KEY'))) configurationError()
}

export function getOpenBankingConfig() {
  const environment = process.env.OPENBANKING_ENV
  if (environment !== 'test' && environment !== 'production') configurationError()
  const apiBaseUrl = environment === 'test' ? 'https://testapi.openbanking.or.kr' : 'https://openapi.openbanking.or.kr'
  const authorizeUrl = `${apiBaseUrl}/oauth/2.0/authorize`
  const tokenUrl = `${apiBaseUrl}/oauth/2.0/token`
  // A typo or a mismatched environment must never send credentials to another host.
  for (const [name, expected] of [['OPENBANKING_API_BASE_URL', apiBaseUrl], ['OPENBANKING_AUTHORIZE_URL', authorizeUrl], ['OPENBANKING_TOKEN_URL', tokenUrl]]) {
    if (process.env[name] && process.env[name]!.replace(/\/$/, '') !== expected) configurationError()
  }
  const clientId = required('OPENBANKING_CLIENT_ID', 40)
  const clientSecret = required('OPENBANKING_CLIENT_SECRET', 40)
  const clientUseCode = required('OPENBANKING_CLIENT_USE_CODE', 10)
  if (!/^[A-Z0-9]{10}$/.test(clientUseCode)) configurationError()
  const redirectUri = required('OPENBANKING_REDIRECT_URI')
  let redirect: URL
  try { redirect = new URL(redirectUri) } catch { configurationError() }
  const localTest = environment === 'test' && redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
  if ((!localTest && redirect.protocol !== 'https:') || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/auth/v1/openbanking') configurationError()
  const scopes = required('OPENBANKING_SCOPES').split(/\s+/)
  if (!scopes.includes('login') || !scopes.includes('inquiry') || scopes.some(scope => !['login', 'inquiry', 'transfer'].includes(scope)) || new Set(scopes).size !== scopes.length) configurationError()
  validateKeys()
  return { environment, apiBaseUrl, authorizeUrl, tokenUrl, clientId, clientSecret, clientUseCode, redirectUri, scope: scopes.join(' ') }
}

export function createOpenBankingAuthorizationUrl(state: string): string {
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) configurationError()
  const config = getOpenBankingConfig()
  const url = new URL(config.authorizeUrl)
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope, state, auth_type: '0', register_info: 'A' }).toString()
  return url.toString()
}

export type OpenBankingTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  refreshExpiresAt: number | null
  scope: string
  userSeqNo: string | null
}

type JsonObject = Record<string, unknown>
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }
function safeProviderCode(value: unknown): string | null { return typeof value === 'string' && /^[AO][0-9]{4}$/.test(value) ? value : null }

async function requestJson(url: string, init: RequestInit): Promise<JsonObject> {
  let response: Response
  let body: unknown
  try {
    response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) })
    body = await response.json()
  } catch {
    console.error('OpenBanking response unavailable', { path: new URL(url).pathname })
    throw new OpenBankingError('unknown')
  }
  if (!isObject(body)) throw new OpenBankingError('unknown')
  const code = safeProviderCode(body.rsp_code)
  if (!response.ok || (code && !['A0000', 'O0000'].includes(code))) {
    console.error('OpenBanking provider rejection', { path: new URL(url).pathname, status: response.status, providerCode: code,
      bankResponseCode: typeof body.bank_rsp_code === 'string' && /^\d{3}$/.test(body.bank_rsp_code) ? body.bank_rsp_code : null })
  }
  if (code && ['O0002', 'O0003', 'O0014', 'O0015'].includes(code)) throw new OpenBankingError('reauth', code)
  if (code && ['O0004', 'O0005', 'O0006', 'O0010', 'O0011', 'A0010', 'A0011', 'A0012', 'A0013', 'A0015', 'A0301', 'A0302', 'A0320', 'A0321', 'A0326'].includes(code)) throw new OpenBankingError('configuration', code)
  if (code === 'O0001') {
    const detail = typeof body.error_code === 'string' ? body.error_code : String(body.error_code ?? '')
    throw new OpenBankingError(/113$/.test(detail) ? 'rejected' : 'configuration', code)
  }
  if (code && ['O0007', 'O0008', 'O0009', 'O0012', 'O0013', 'A0016', 'A0020'].includes(code)) throw new OpenBankingError('transient', code)
  if (code && ['A0001', 'A0007', 'A0017'].includes(code)) throw new OpenBankingError('unknown', code)
  if (!response.ok) {
    if (body.error === 'invalid_grant') throw new OpenBankingError('reauth')
    if (body.error === 'invalid_client' || body.error === 'invalid_scope') configurationError()
    if (response.status === 401) throw new OpenBankingError('reauth', code)
    // A gateway/server error does not establish whether the remote operation committed.
    throw new OpenBankingError(response.status >= 500 ? 'unknown' : 'rejected', code)
  }
  return body
}

function parseTokens(body: JsonObject, scope: string, user: boolean, issuedAt: number, refresh = false): OpenBankingTokens {
  const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 400 && !/\s/.test(value)
  if (!validToken(body.access_token) || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 366 * 24 * 60 * 60) throw new OpenBankingError('unknown')
  if (typeof body.scope !== 'string' || scope.split(' ').some(value => !body.scope!.toString().split(' ').includes(value)) || (!user && body.scope !== 'oob') || (user && body.scope.split(' ').includes('oob'))) throw new OpenBankingError('unknown')
  if (user && (typeof body.user_seq_no !== 'string' || !/^[A-Z0-9]{10}$/.test(body.user_seq_no))) throw new OpenBankingError('unknown')
  if (user && !refresh && !validToken(body.refresh_token)) throw new OpenBankingError('unknown')
  if (body.refresh_token !== undefined && !validToken(body.refresh_token)) throw new OpenBankingError('unknown')
  return {
    accessToken: body.access_token,
    refreshToken: validToken(body.refresh_token) ? body.refresh_token : null,
    expiresAt: issuedAt + body.expires_in,
    // §2.1.5: user refresh tokens last 10 days longer; no invented JWT validation.
    refreshExpiresAt: validToken(body.refresh_token) ? issuedAt + body.expires_in + TOKEN_GRACE_SECONDS : null,
    scope: body.scope,
    userSeqNo: user ? String(body.user_seq_no) : null,
  }
}

async function requestToken(values: Record<string, string>, scope: string, user: boolean, refresh = false): Promise<OpenBankingTokens> {
  const config = getOpenBankingConfig()
  const issuedAt = Math.floor(Date.now() / 1000)
  const body = await requestJson(config.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }),
  })
  if (body.rsp_code && !['A0000', 'O0000'].includes(String(body.rsp_code))) throw new OpenBankingError('rejected', safeProviderCode(body.rsp_code))
  if (!user && body.client_use_code !== config.clientUseCode) throw new OpenBankingError('unknown')
  return parseTokens(body, scope, user, issuedAt, refresh)
}

export async function exchangeOpenBankingCode(code: string): Promise<OpenBankingTokens> {
  if (!code || code.length > 2048 || /\s/.test(code)) throw new OpenBankingError('rejected')
  const config = getOpenBankingConfig()
  return requestToken({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }, config.scope, true)
}

export async function refreshOpenBankingToken(refreshToken: string, scope = getOpenBankingConfig().scope): Promise<OpenBankingTokens> {
  if (!refreshToken || !scope.split(' ').includes('login') || scope.split(' ').some(value => !['login', 'inquiry', 'transfer'].includes(value))) configurationError()
  return requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken, scope }, scope, true, true)
}

export async function issueOpenBankingServiceToken(): Promise<OpenBankingTokens> {
  try {
    return await requestToken({ grant_type: 'client_credentials', scope: 'oob' }, 'oob', false)
  } catch (error) {
    // An institution credential failure cannot be repaired by user re-consent.
    if (error instanceof OpenBankingError && error.reauth) throw new OpenBankingError('configuration', error.providerCode)
    throw error
  }
}

export async function listOpenBankingAccounts(accessToken: string, userSeqNo: string): Promise<RegisteredBankAccount[]> {
  const config = getOpenBankingConfig()
  if (!accessToken || !/^[A-Z0-9]{10}$/.test(userSeqNo)) configurationError()
  const url = new URL(`${config.apiBaseUrl}/v2.0/account/list`)
  url.search = new URLSearchParams({ user_seq_no: userSeqNo, include_cancel_yn: 'N', sort_order: 'D' }).toString()
  const body = await requestJson(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } })
  if (body.rsp_code !== 'A0000') throw new OpenBankingError('rejected', safeProviderCode(body.rsp_code))
  const count = typeof body.res_cnt === 'string' && /^[0-9]{1,5}$/.test(body.res_cnt) ? Number(body.res_cnt) : body.res_cnt
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 99_999 || !Array.isArray(body.res_list) || body.res_list.length !== count) throw new OpenBankingError('unknown')
  const banks = config.environment === 'test' ? [...BANKS, ...TEST_BANKS] : BANKS
  const accounts: RegisteredBankAccount[] = []
  const fintechUseNums = new Set<string>()
  for (const row of body.res_list) {
    if (!isObject(row) || typeof row.account_state !== 'string' || typeof row.inquiry_agree_yn !== 'string' || typeof row.account_holder_type !== 'string' || typeof row.bank_code_std !== 'string' || !/^[0-9]{3}$/.test(row.bank_code_std)) throw new OpenBankingError('unknown')
    const bank = banks.find(item => item.code === row.bank_code_std)
    if (row.account_state !== '01' || row.inquiry_agree_yn !== 'Y' || row.account_holder_type !== 'P' || !bank) continue
    const holder = typeof row.account_holder_name === 'string' ? normalizeAccountHolder(row.account_holder_name) : ''
    if (typeof row.fintech_use_num !== 'string' || !/^[0-9]{24}$/.test(row.fintech_use_num) || fintechUseNums.has(row.fintech_use_num) || !holder || holder.length > 40 || /[\p{Cc}\p{Cf}]/u.test(holder)) throw new OpenBankingError('unknown')
    if (typeof row.account_num_masked !== 'string' || !/^[0-9* -]{1,20}$/.test(row.account_num_masked) || !/[0-9*]/.test(row.account_num_masked)) throw new OpenBankingError('unknown')
    // §2.2.3: full numbers are optional and only supplied to qualified institutions.
    // Never reconstruct an account number from its masked form or fintech identifier.
    const accountNumber = row.account_num === undefined || row.account_num === null || row.account_num === '' ? null : row.account_num
    if (accountNumber !== null && (typeof accountNumber !== 'string' || !/^[0-9]{1,16}$/.test(accountNumber))) throw new OpenBankingError('unknown')
    fintechUseNums.add(row.fintech_use_num)
    accounts.push({ fintechUseNum: row.fintech_use_num, bankCode: bank.code, bankName: bank.name, accountHolder: holder, accountNumber, accountNumberMasked: row.account_num_masked.trim() })
  }
  return accounts
}

export type VerifiedBankAccount = Omit<BankAccountInput, 'birthDate' | 'expectedBankVersion' | 'confirmRejoin' | 'verifyWithOpenBanking'> & {
  verifiedAt: number
  verificationTranId: string
}

export async function inquireRealName(input: BankAccountInput, serviceAccessToken: string, bankTranId: string): Promise<VerifiedBankAccount> {
  if (!input.verifyWithOpenBanking) throw new AppError(400, 'invalid_input', '금융결제원 계좌 확인 요청이 필요해요')
  const config = getOpenBankingConfig()
  if (!bankTranId.startsWith(`${config.clientUseCode}U`) || !/^[A-Z0-9]{20}$/.test(bankTranId)) configurationError()
  const holderInfo = input.birthDate.slice(2).replaceAll('-', '')
  const now = new Date()
  const tranDtime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '')
  const body = await requestJson(`${config.apiBaseUrl}/v2.0/inquiry/real_name`, {
    method: 'POST', headers: { Authorization: `Bearer ${serviceAccessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ bank_tran_id: bankTranId, bank_code_std: input.bankCode, account_num: input.accountNumber, account_holder_info_type: ' ', account_holder_info: holderInfo, tran_dtime: tranDtime }),
  })
  // Account errors are separate from provider outages and institution configuration errors.
  if (config.environment === 'test' && body.rsp_code === 'A0002' && body.bank_rsp_code === '818') {
    throw new AppError(424, 'openbanking_test_data_missing', '금융결제원에 입력한 계좌정보와 일치하는 테스트 응답이 없어요. 계좌실명조회 테스트 정보를 확인해 주세요')
  }
  if (body.rsp_code === 'A0312') throw new AppError(409, 'account_holder_mismatch', '예금주명을 다시 확인해 주세요', { field: 'accountHolder' })
  if (['A0000', 'A0002'].includes(String(body.rsp_code)) && typeof body.bank_rsp_code === 'string' && /^(41[1-9]|42[0-9]|43[0-9]|44[1-3]|46[1-8]|47[0-7]|48[1-6]|490|499|553)$/.test(body.bank_rsp_code)) {
    throw new AppError(422, 'bank_account_unverified', '계좌정보를 확인하지 못했어요. 은행, 계좌번호와 생년월일을 확인해 주세요')
  }
  if (body.rsp_code !== 'A0000' || body.bank_rsp_code !== '000') {
    console.error('OpenBanking bank response rejected', { providerCode: safeProviderCode(body.rsp_code),
      bankResponseCode: typeof body.bank_rsp_code === 'string' && /^\d{3}$/.test(body.bank_rsp_code) ? body.bank_rsp_code : null })
    throw new OpenBankingError('transient', safeProviderCode(body.rsp_code))
  }
  const mismatchedFields = Object.entries({ bank_tran_id: bankTranId, bank_code_std: input.bankCode, account_num: input.accountNumber,
    account_holder_info: holderInfo, account_holder_info_type: ' ' }).filter(([field, expected]) => body[field] !== expected).map(([field]) => field)
  const accountHolder = typeof body.account_holder_name === 'string' ? normalizeAccountHolder(body.account_holder_name) : ''
  if (!accountHolder) mismatchedFields.push('account_holder_name')
  if (mismatchedFields.length) {
    // Field names and presence only; never log account details, DOB, tokens, or provider messages.
    console.error('OpenBanking response mismatch', { fields: mismatchedFields,
      missing: mismatchedFields.filter(field => !Object.hasOwn(body, field)),
      empty: mismatchedFields.filter(field => body[field] === '') })
    throw new OpenBankingError('unknown')
  }
  if (accountHolder !== input.accountHolder) throw new AppError(409, 'account_holder_mismatch', '입력한 예금주명과 계좌의 예금주명이 일치하지 않아요', { field: 'accountHolder' })
  return { bankCode: input.bankCode, bankName: input.bankName, accountNumber: input.accountNumber, accountHolder, verifiedAt: Math.floor(now.getTime() / 1000), verificationTranId: bankTranId }
}

export async function disconnectOpenBankingUser(input: { accessToken: string; userSeqNo: string }): Promise<void> {
  const config = getOpenBankingConfig()
  const body = await requestJson(`${config.apiBaseUrl}/v2.0/user/close`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ client_use_code: config.clientUseCode, user_seq_no: input.userSeqNo }),
  })
  // A0014 is the documented 'withdrawn member'. No other failure implies completion.
  if (body.rsp_code !== 'A0000' && body.rsp_code !== 'A0014') throw new OpenBankingError('rejected', safeProviderCode(body.rsp_code))
}

export function encryptOpenBankingSecret(value: string, context: string): string {
  const key = secretKey('OPENBANKING_TOKEN_ENCRYPTION_KEY')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`v1:${context}`))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptOpenBankingSecret(value: string, context: string): string {
  const key = secretKey('OPENBANKING_TOKEN_ENCRYPTION_KEY')
  try {
    const [version, nonce, tag, encrypted, extra] = value.split('.')
    if (version !== 'v1' || !nonce || !tag || !encrypted || extra !== undefined || ![nonce, tag, encrypted].every(part => /^[A-Za-z0-9_-]+$/.test(part))) configurationError()
    const iv = Buffer.from(nonce, 'base64url')
    const authTag = Buffer.from(tag, 'base64url')
    if (iv.length !== 12 || authTag.length !== 16) configurationError()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`v1:${context}`))
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
  } catch { configurationError() }
}

export function bankAccountRequestFingerprint(userId: string, input: BankAccountInput): string {
  let key: Buffer
  if (input.verifyWithOpenBanking) {
    validateKeys()
    key = secretKey('OPENBANKING_REQUEST_HMAC_KEY')
  } else {
    const sessionSecret = process.env.AUTH_JWT_SECRET
    if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 bytes')
    key = Buffer.from(sessionSecret)
  }
  const payload = JSON.stringify(['PUT /api/me/bank-account', userId, input.bankCode, input.accountNumber, input.birthDate, input.accountHolder, input.expectedBankVersion, input.verifyWithOpenBanking])
  return createHmac('sha256', key).update(payload).digest('hex')
}
