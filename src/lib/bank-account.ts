import { AppError } from './errors.ts'

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

export type BankAccountInput = {
  bankCode: string
  bankName: string
  accountNumber: string
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
  if (typeof input.accountHolder !== 'string' || input.accountHolder.length > 100) invalidField('accountHolder', '예금주명을 확인해 주세요')
  const accountHolder = normalizeAccountHolder(input.accountHolder)
  if (!accountHolder || accountHolder.length > 40 || /[\p{Cc}\p{Cf}]/u.test(accountHolder)) invalidField('accountHolder', '예금주명을 확인해 주세요')
  if (typeof input.expectedBankVersion !== 'number' || !Number.isSafeInteger(input.expectedBankVersion) || input.expectedBankVersion < 0 || input.expectedBankVersion >= 2_147_483_647) {
    invalidField('expectedBankVersion', '계좌정보를 다시 불러온 뒤 저장해 주세요')
  }
  if (input.confirmRejoin !== undefined && typeof input.confirmRejoin !== 'boolean') invalidField('confirmRejoin', '재가입 동의를 확인해 주세요')
  return { bankCode: bank.code, bankName: bank.name, accountNumber, accountHolder, expectedBankVersion: input.expectedBankVersion, confirmRejoin: input.confirmRejoin === true }
}
