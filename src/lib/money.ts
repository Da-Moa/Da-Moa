export type Currency = 'KRW' | 'JPY' | 'USD'
export const MAX_EXPENSE_MAJOR = 100_000_000n
export const MAX_ROUND_TOTAL_MAJOR = 1_000_000_000n

export function requireCurrency(value: unknown): Currency {
  if (value !== 'KRW' && value !== 'JPY' && value !== 'USD') throw new Error('unsupported_currency')
  return value
}

function groupWhole(whole: string): string {
  const firstGroup = whole.length % 3 || 3
  const groups = [whole.slice(0, firstGroup)]
  for (let index = firstGroup; index < whole.length; index += 3) groups.push(whole.slice(index, index + 3))
  return groups.join(',')
}

export const minorLimit = (major: bigint, currency: Currency) => major * (currency === 'USD' ? 100n : 1n)

export function expenseInputMaximum(totalMinor: string, previousMinor: string | null | undefined, currency: Currency): bigint {
  const remaining = minorLimit(MAX_ROUND_TOTAL_MAJOR, currency) - BigInt(totalMinor) + BigInt(previousMinor ?? 0)
  const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency)
  return remaining <= 0n ? 0n : remaining < maximum ? remaining : maximum
}

/** Format a valid partial amount while the user is typing, without losing precision. */
export function formatAmountInput(value: string, currency: Currency, maximumMinor?: bigint): string | null {
  requireCurrency(currency)
  let plain = value.replace(/,/g, '')
  if (!plain) return ''
  if (!(currency === 'USD' ? /^\d+(?:\.\d{0,2})?$/.test(plain) : /^\d+$/.test(plain))) return null
  if (maximumMinor !== undefined) {
    const [whole, fraction = ''] = plain.split('.')
    const minor = currency === 'USD' ? BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) : BigInt(whole)
    if (minor > maximumMinor) {
      const digits = maximumMinor.toString().padStart(currency === 'USD' ? 3 : 1, '0')
      plain = currency === 'USD' ? `${digits.slice(0, -2)}.${digits.slice(-2)}` : digits
    }
  }
  const decimalAt = currency === 'USD' ? plain.indexOf('.') : -1
  const wholePart = decimalAt < 0 ? plain : plain.slice(0, decimalAt)
  return `${groupWhole(wholePart)}${decimalAt < 0 ? '' : plain.slice(decimalAt)}`
}

/** Parse an exact, positive decimal amount without passing through Number. */
export function parseAmount(amount: unknown, currency: Currency): bigint {
  requireCurrency(currency)
  if (typeof amount !== 'string' || amount !== amount.trim() || !(currency === 'USD' ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/).test(amount)) {
    throw new Error('invalid_amount')
  }
  const [whole, fraction = ''] = amount.split('.')
  const minor = currency === 'USD' ? BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) : BigInt(whole)
  if (minor <= 0n) throw new Error('invalid_amount')
  return minor
}

/** Format a signed minor-unit string, including values beyond Number.MAX_SAFE_INTEGER. */
export function formatMoney(amountMinor: string, currency: Currency): string {
  requireCurrency(currency)
  if (typeof amountMinor !== 'string' || amountMinor !== amountMinor.trim() || !/^-?\d+$/.test(amountMinor)) throw new Error('invalid_amount')
  const amount = BigInt(amountMinor)
  const negative = amount < 0n ? '-' : ''
  const absolute = (amount < 0n ? -amount : amount).toString()
  const digits = currency === 'USD' ? absolute.padStart(3, '0') : absolute
  const whole = currency === 'USD' ? digits.slice(0, -2) : digits
  const grouped = groupWhole(whole)
  if (currency === 'USD') return `${negative}$${grouped}.${digits.slice(-2)}`
  return `${negative}${grouped}${currency === 'KRW' ? '원' : '엔'}`
}
