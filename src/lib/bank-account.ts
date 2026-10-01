import { AppError } from './app-error'
import { detect, formatAccount, institutions } from 'korean-account'

export const BANKS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '002', name: 'KDB산업은행' }, { code: '003', name: 'IBK기업은행' },
  { code: '004', name: 'KB국민은행' }, { code: '007', name: '수협은행' },
  { code: '011', name: 'NH농협은행' }, { code: '012', name: '지역농축협' },
  { code: '020', name: '우리은행' }, { code: '023', name: 'SC제일은행' },
  { code: '027', name: '한국씨티은행' }, { code: '030', name: '수협중앙회' },
  { code: '031', name: '아이엠뱅크' }, { code: '032', name: '부산은행' },
  { code: '034', name: '광주은행' }, { code: '035', name: '제주은행' },
  { code: '037', name: '전북은행' }, { code: '039', name: '경남은행' },
  { code: '045', name: '새마을금고' }, { code: '048', name: '신협' },
  { code: '050', name: '저축은행' }, { code: '064', name: '산림조합' },
  { code: '071', name: '우체국' }, { code: '081', name: '하나은행' },
  { code: '088', name: '신한은행' }, { code: '089', name: '케이뱅크' },
  { code: '090', name: '카카오뱅크' }, { code: '092', name: '토스뱅크' },
  { code: '209', name: '유안타증권' }, { code: '218', name: 'KB증권' },
  { code: '227', name: '다올투자증권' }, { code: '238', name: '미래에셋증권' },
  { code: '240', name: '삼성증권' }, { code: '243', name: '한국투자증권' },
  { code: '247', name: 'NH투자증권' }, { code: '261', name: '교보증권' },
  { code: '262', name: '아이엠증권' }, { code: '263', name: '현대차증권' },
  { code: '264', name: '키움증권' }, { code: '265', name: 'LS증권' },
  { code: '266', name: 'SK증권' }, { code: '267', name: '대신증권' },
  { code: '269', name: '한화투자증권' }, { code: '270', name: '하나증권' },
  { code: '271', name: '토스증권' }, { code: '278', name: '신한투자증권' },
  { code: '279', name: 'DB증권' }, { code: '280', name: '유진투자증권' },
  { code: '287', name: '메리츠증권' },
]

const PHONE_NUMBER = /^01[016789]\d{7,8}$/
// Confirmed 10–11 digit aliases: IBK lifetime accounts and KB customer-designated accounts.
// https://blog.ibk.co.kr/452 and the korean-account KFTC CMS catalog.
// ponytail: Only confirmed banks; extend after checking another bank's alias rules.
const PHONE_ACCOUNT_BANKS: readonly string[] = ['003', '004']

// The CMS catalog uses 005 for Hana Bank; our transfer bank list uses 081.
function supportedBankCode(code: string): string | undefined {
  const bankCode = code === '005' ? '081' : code
  if (code === '081') return undefined // Hana Securities CMA, not Hana Bank.
  return BANKS.some(bank => bank.code === bankCode) ? bankCode : undefined
}

export function suggestBanks(value: string): string[] {
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length < 3) return []
  if (PHONE_NUMBER.test(digits)) return [...PHONE_ACCOUNT_BANKS]
  const suggested = new Set<string>()
  for (const [code, pattern, groups] of DISPLAY_PATTERNS) {
    const length = groups.reduce((sum, size) => sum + size, 0)
    if (digits.length <= length && pattern.test(digits.padEnd(length, '0'))) suggested.add(code)
  }
  for (const result of detect(digits, { limit: 57, minScore: 4 })) {
    const code = supportedBankCode(result.institution.code)
    if (code) suggested.add(code)
  }
  // The detector's length score needs nearly complete input; use its registered leading codes while typing.
  for (const institution of institutions) {
    const code = supportedBankCode(institution.code)
    if (code && institution.patterns.some(pattern => pattern.identifierPosition?.start === 0 &&
      pattern.template.replace(/-/g, '').length >= digits.length &&
      pattern.identifiers?.some(prefix => prefix.length >= 3 && digits.startsWith(prefix)))) suggested.add(code)
  }
  return [...suggested].slice(0, 5)
}

function catalogPatterns(bankCode: string) {
  return institutions.filter(institution => institution.code === (bankCode === '081' ? '005' : bankCode))
    .flatMap(institution => institution.patterns)
}

// ponytail: Supplemental layouts cover identified prefixes; add others when their bank grouping is verified.
// https://image.kebhana.com/cont/download/menu/menu08/notice_1500400.pdf
// https://builder.tossbank.com/to/75b8a56e09164ed9b614837468cd2c58
const DISPLAY_PATTERNS: ReadonlyArray<readonly [string, RegExp, readonly number[]]> = [
  ['004', /^\d{4}(?:03|23|26)\d{8}$/, [6, 2, 6]],
  ['088', /^(?:230|223)\d{9}$/, [3, 3, 6]],
  ['003', /^\d{9}14\d{3}$/, [3, 6, 2, 3]],
  ['002', /^(?:031|032|037)\d{11}$/, [3, 4, 4, 3]],
  ['007', /^(?:1400|1410)\d{8}$/, [4, 4, 4]],
  ['090', /^\d355\d{9}$/, [4, 2, 7]],
  ['090', /^3310\d{9}$/, [4, 2, 7]],
  ['089', /^(?:1102|1001)\d{8}$/, [3, 3, 6]],
  ['081', /^402\d{11}$/, [3, 6, 5]],
  ['092', /^1000\d{8}$/, [4, 4, 4]],
  ['092', /^300\d{9}$/, [4, 4, 4]],
  ['032', /^104\d{10}$/, [3, 4, 4, 2]],
]

export function formatAccountNumber(bankCodeOrName: string | null, value: string, partial = false): string {
  const digits = value.replace(/[ -]/g, '')
  const code = BANKS.find(bank => bank.code === bankCodeOrName || bank.name === bankCodeOrName)?.code
  if (!/^\d+$/.test(digits)) return value
  if (PHONE_NUMBER.test(digits)) return digits
  if (code === '004' && digits.length === 14) return digits.replace(/^(\d{6})(\d{2})(\d{6})$/, '$1-$2-$3')
  if (code === '003' && digits.length === 14) return digits.replace(/^(\d{3})(\d{6})(\d{2})(\d{3})$/, '$1-$2-$3-$4')
  const matches = DISPLAY_PATTERNS.filter(([bankCode, pattern, groups]) => bankCode === code && pattern.test(partial ? digits.padEnd(groups.reduce((sum, size) => sum + size, 0), '0') : digits))
  if (matches.length === 1) {
    let offset = 0
    return matches[0][2].map(size => {
      const part = digits.slice(offset, offset + size)
      offset += size
      return part
    }).filter(Boolean).join('-')
  }
  if (!code) return digits
  const patterns = catalogPatterns(code).filter(pattern => pattern.template.replace(/-/g, '').length >= digits.length &&
    (pattern.identifierPosition?.start === 0 && pattern.identifiers?.some(prefix => digits.startsWith(prefix))))
  if (partial && patterns.length === 1) return formatAccount(digits, patterns[0].template)
  const institution = institutions.find(item => item.code === (code === '081' ? '005' : code))
  const result = institution && detect(digits, { include: [institution.id], minScore: 7, limit: 1 })[0]
  return result && result.matchedPattern.template.replace(/-/g, '').length === digits.length ? result.formatted : digits
}

export function recognizedAccountNumber(bankCode: string, value: string): string | null {
  const digits = value.replace(/[ -]/g, '')
  if (!/^\d{1,16}$/.test(digits)) return null
  if (PHONE_NUMBER.test(digits)) return PHONE_ACCOUNT_BANKS.includes(bankCode) ? digits : null
  const knownLayout = DISPLAY_PATTERNS.some(([code, pattern]) => code === bankCode && pattern.test(digits))
  const institution = institutions.find(item => item.code === (bankCode === '081' ? '005' : bankCode))
  const match = institution && detect(digits, { include: [institution.id], minScore: 7, limit: 1 })[0]
  const exactMatch = match && match.matchedPattern.template.replace(/-/g, '').length === digits.length
  return knownLayout || exactMatch ? formatAccountNumber(bankCode, digits) : null
}

export function parseClipboardAccount(text: string, selectedBankCode?: string): { accountNumber: string; bankCode: string | null } | null {
  if (text.length > 4096 || /[*xX•]/.test(text)) return null
  const compact = text.replace(/\s/g, '').toLowerCase()
  const named = BANKS.flatMap(bank => {
    const name = bank.name.replace(/^(KDB|IBK|KB|NH|SC|한국)/, '')
    const short = name.replace(/(?:투자증권|은행|증권)$/, '')
    const aliases = [bank.name, name, short, ...(bank.code === '031' ? ['iM뱅크', '대구은행'] : []), ...(bank.code === '012' ? ['농협', '지역농협', '지역축협', '농축협', '축협'] : [])]
    return aliases.map(name => name.toLowerCase()).filter(name => name.length >= 2 && compact.includes(name)).map(name => ({ code: bank.code, name }))
  })
  const banks = [...new Set(named.filter(bank => !named.some(other => other.name !== bank.name && other.name.includes(bank.name))).map(bank => bank.code))]
  const namedCode = banks.length === 1 ? banks[0] : null
  const accounts = new Map<string, string | null>()
  for (const match of text.matchAll(/\d(?:[\d \t-]*\d)?/g)) {
    const digits = match[0].replace(/[ \t-]/g, '')
    if (!/^\d{7,16}$/.test(digits)) continue
    if (PHONE_NUMBER.test(digits)) {
      const code = banks.length ? namedCode : selectedBankCode
      if (!code || !recognizedAccountNumber(code, digits)) return null
      accounts.set(digits, code)
      continue
    }
    const candidates = BANKS.filter(bank => recognizedAccountNumber(bank.code, digits))
    accounts.set(digits, banks.length ? namedCode : (candidates.length === 1 ? candidates[0].code : null))
  }
  if (accounts.size !== 1) return null
  const [accountNumber, bankCode] = [...accounts][0]
  return { accountNumber, bankCode }
}

export type BankAccountInput = {
  bankCode: string
  bankName: string
  accountNumber: string
  formattedAccountNumber: string
  accountHolder: string
  expectedBankVersion: number
  confirmRejoin: boolean
}

function invalidField(field: string, message: string): never {
  throw new AppError(400, 'invalid_input', message, { field })
}

export function normalizeAccountHolder(value: string): string {
  return value.normalize('NFC').trim()
}

export function normalizeBankAccountInput(
  input: Record<string, unknown>,
  options: { onboarding?: boolean } = {},
): BankAccountInput {
  const allowed = ['bankCode', 'accountNumber', 'accountHolder', 'expectedBankVersion', 'verifyWithOpenBanking', ...(options.onboarding ? ['confirmRejoin'] : [])]
  if (Object.keys(input).some(key => !allowed.includes(key))) invalidField('form', '지원하지 않는 계좌 입력 항목이 있어요')
  if (input.verifyWithOpenBanking !== undefined && input.verifyWithOpenBanking !== false) invalidField('verifyWithOpenBanking', '계좌 자동 확인은 지원하지 않아요')
  const bank = BANKS.find(item => item.code === input.bankCode)
  if (!bank) invalidField('bankCode', '지원하는 은행을 선택해 주세요')
  if (typeof input.accountNumber !== 'string' || input.accountNumber.length > 64) invalidField('accountNumber', '계좌번호를 확인해 주세요')
  const accountNumber = input.accountNumber.replace(/[ -]/g, '')
  if (!/^[0-9]{1,16}$/.test(accountNumber)) invalidField('accountNumber', '계좌번호는 숫자 16자리 이내로 입력해 주세요')
  const formattedAccountNumber = formatAccountNumber(bank.code, accountNumber)
  if (typeof input.accountHolder !== 'string' || input.accountHolder.length > 100) invalidField('accountHolder', '예금주명을 확인해 주세요')
  const accountHolder = normalizeAccountHolder(input.accountHolder)
  if (!accountHolder || accountHolder.length > 40 || /[\p{Cc}\p{Cf}]/u.test(accountHolder)) invalidField('accountHolder', '예금주명을 확인해 주세요')
  if (typeof input.expectedBankVersion !== 'number' || !Number.isSafeInteger(input.expectedBankVersion) || input.expectedBankVersion < 0 || input.expectedBankVersion >= 2_147_483_647) {
    invalidField('expectedBankVersion', '계좌정보를 다시 불러온 뒤 저장해 주세요')
  }
  if (input.confirmRejoin !== undefined && typeof input.confirmRejoin !== 'boolean') invalidField('confirmRejoin', '재가입 동의를 확인해 주세요')
  return { bankCode: bank.code, bankName: bank.name, accountNumber, formattedAccountNumber, accountHolder, expectedBankVersion: input.expectedBankVersion, confirmRejoin: input.confirmRejoin === true }
}
