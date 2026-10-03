// Selection coverage and sources: spec/통화지원-spec.md. Decimals follow ISO 4217.
export const CURRENCIES = {
  KRW: { name: '대한민국 원', decimals: 0, flag: 'kr', countries: '한국' },
  USD: { name: '미국 달러', decimals: 2, flag: 'us', countries: '미국 괌 사이판 캄보디아 몰디브' },
  JPY: { name: '일본 엔', decimals: 0, flag: 'jp', countries: '일본' },
  VND: { name: '베트남 동', decimals: 0, flag: 'vn', countries: '베트남' },
  CNY: { name: '중국 위안', decimals: 2, flag: 'cn', countries: '중국' },
  THB: { name: '태국 바트', decimals: 2, flag: 'th', countries: '태국' },
  TWD: { name: '대만 달러', decimals: 2, flag: 'tw', countries: '대만' },
  PHP: { name: '필리핀 페소', decimals: 2, flag: 'ph', countries: '필리핀' },
  HKD: { name: '홍콩 달러', decimals: 2, flag: 'hk', countries: '홍콩 마카오' },
  SGD: { name: '싱가포르 달러', decimals: 2, flag: 'sg', countries: '싱가포르' },
  MOP: { name: '마카오 파타카', decimals: 2, flag: 'mo', countries: '마카오' },
  MYR: { name: '말레이시아 링깃', decimals: 2, flag: 'my', countries: '말레이시아' },
  IDR: { name: '인도네시아 루피아', decimals: 2, flag: 'id', countries: '인도네시아 발리' },
  EUR: { name: '유럽 유로', decimals: 2, flag: 'eu', countries: '프랑스 이탈리아 스페인 독일 오스트리아 포르투갈 그리스 네덜란드 벨기에 크로아티아 핀란드' },
  GBP: { name: '영국 파운드', decimals: 2, flag: 'gb', countries: '영국' },
  CHF: { name: '스위스 프랑', decimals: 2, flag: 'ch', countries: '스위스' },
  AUD: { name: '호주 달러', decimals: 2, flag: 'au', countries: '호주' },
  CAD: { name: '캐나다 달러', decimals: 2, flag: 'ca', countries: '캐나다' },
  KHR: { name: '캄보디아 리엘', decimals: 2, flag: 'kh', countries: '캄보디아' },
  LAK: { name: '라오스 킵', decimals: 2, flag: 'la', countries: '라오스' },
  RUB: { name: '러시아 루블', decimals: 2, flag: 'ru', countries: '러시아' },
  TRY: { name: '튀르키예 리라', decimals: 2, flag: 'tr', countries: '튀르키예 터키' },
  MNT: { name: '몽골 투그릭', decimals: 2, flag: 'mn', countries: '몽골' },
  CZK: { name: '체코 코루나', decimals: 2, flag: 'cz', countries: '체코' },
  HUF: { name: '헝가리 포린트', decimals: 2, flag: 'hu', countries: '헝가리' },
  NZD: { name: '뉴질랜드 달러', decimals: 2, flag: 'nz', countries: '뉴질랜드' },
  PLN: { name: '폴란드 즈워티', decimals: 2, flag: 'pl', countries: '폴란드' },
  NOK: { name: '노르웨이 크로네', decimals: 2, flag: 'no', countries: '노르웨이' },
  SEK: { name: '스웨덴 크로나', decimals: 2, flag: 'se', countries: '스웨덴' },
  DKK: { name: '덴마크 크로네', decimals: 2, flag: 'dk', countries: '덴마크' },
  AED: { name: '아랍에미리트 디르함', decimals: 2, flag: 'ae', countries: '아랍에미리트 두바이' },
  INR: { name: '인도 루피', decimals: 2, flag: 'in', countries: '인도' },
  NPR: { name: '네팔 루피', decimals: 2, flag: 'np', countries: '네팔' },
  LKR: { name: '스리랑카 루피', decimals: 2, flag: 'lk', countries: '스리랑카' },
  MVR: { name: '몰디브 루피야', decimals: 2, flag: 'mv', countries: '몰디브' },
  UZS: { name: '우즈베키스탄 숨', decimals: 2, flag: 'uz', countries: '우즈베키스탄' },
  KZT: { name: '카자흐스탄 텡게', decimals: 2, flag: 'kz', countries: '카자흐스탄' },
  MXN: { name: '멕시코 페소', decimals: 2, flag: 'mx', countries: '멕시코' },
  EGP: { name: '이집트 파운드', decimals: 2, flag: 'eg', countries: '이집트' },
  ZAR: { name: '남아프리카공화국 랜드', decimals: 2, flag: 'za', countries: '남아프리카공화국 남아공' },
  GEL: { name: '조지아 라리', decimals: 2, flag: 'ge', countries: '조지아' },
} as const
export type Currency = keyof typeof CURRENCIES
export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[]
export const MAX_EXPENSE_MAJOR = 100_000_000n
export const MAX_ROUND_TOTAL_MAJOR = 1_000_000_000n

export function requireCurrency(value: unknown): Currency {
  if (typeof value !== 'string' || !Object.hasOwn(CURRENCIES, value)) throw new Error('unsupported_currency')
  return value as Currency
}

export const currencyDecimals = (currency: Currency) => CURRENCIES[requireCurrency(currency)].decimals
export const amountInputPattern = (currency: Currency) => `[0-9]{1,3}(,[0-9]{3})*${currencyDecimals(currency) ? `([.][0-9]{1,${currencyDecimals(currency)}})?` : ''}`

function groupWhole(whole: string): string {
  const firstGroup = whole.length % 3 || 3
  const groups = [whole.slice(0, firstGroup)]
  for (let index = firstGroup; index < whole.length; index += 3) groups.push(whole.slice(index, index + 3))
  return groups.join(',')
}

export const minorLimit = (major: bigint, currency: Currency) => major * 10n ** BigInt(currencyDecimals(currency))

/** Exact minor-unit conversion shared by display, editing and input clamping. */
export function minorToAmount(amountMinor: string, currency: Currency): string {
  const decimals = currencyDecimals(currency)
  if (typeof amountMinor !== 'string' || amountMinor !== amountMinor.trim() || !/^-?\d+$/.test(amountMinor)) throw new Error('invalid_amount')
  const amount = BigInt(amountMinor)
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0')
  return `${amount < 0n ? '-' : ''}${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits}`
}

export function expenseInputMaximum(totalMinor: string, previousMinor: string | null | undefined, currency: Currency): bigint {
  const remaining = minorLimit(MAX_ROUND_TOTAL_MAJOR, currency) - BigInt(totalMinor) + BigInt(previousMinor ?? 0)
  const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency)
  return remaining <= 0n ? 0n : remaining < maximum ? remaining : maximum
}

/** Format a valid partial amount while the user is typing, without losing precision. */
export function formatAmountInput(value: string, currency: Currency, maximumMinor?: bigint): string | null {
  const decimals = currencyDecimals(currency)
  let plain = value.replace(/,/g, '')
  if (!plain) return ''
  if (!(decimals ? new RegExp(`^\\d+(?:\\.\\d{0,${decimals}})?$`).test(plain) : /^\d+$/.test(plain))) return null
  if (maximumMinor !== undefined) {
    const [whole, fraction = ''] = plain.split('.')
    const minor = minorLimit(BigInt(whole), currency) + BigInt(fraction.padEnd(decimals, '0') || '0')
    if (minor > maximumMinor) {
      plain = minorToAmount(maximumMinor.toString(), currency)
    }
  }
  const decimalAt = plain.indexOf('.')
  const wholePart = decimalAt < 0 ? plain : plain.slice(0, decimalAt)
  return `${groupWhole(wholePart)}${decimalAt < 0 ? '' : plain.slice(decimalAt)}`
}

/** Parse an exact, positive decimal amount without passing through Number. */
export function parseAmount(amount: unknown, currency: Currency): bigint {
  const decimals = currencyDecimals(currency)
  if (typeof amount !== 'string' || amount !== amount.trim() || !(decimals ? new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`) : /^\d+$/).test(amount)) {
    throw new Error('invalid_amount')
  }
  const [whole, fraction = ''] = amount.split('.')
  const minor = minorLimit(BigInt(whole), currency) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (minor <= 0n) throw new Error('invalid_amount')
  return minor
}

/** Format a signed minor-unit string, including values beyond Number.MAX_SAFE_INTEGER. */
export function formatMoney(amountMinor: string, currency: Currency): string {
  const amount = minorToAmount(amountMinor, currency)
  const negative = amount.startsWith('-') ? '-' : ''
  const [whole, fraction] = amount.replace('-', '').split('.')
  const number = `${groupWhole(whole)}${fraction === undefined ? '' : `.${fraction}`}`
  if (currency === 'USD') return `${negative}$${number}`
  return `${negative}${number}${currency === 'KRW' ? '원' : currency === 'JPY' ? '엔' : ` ${currency}`}`
}
