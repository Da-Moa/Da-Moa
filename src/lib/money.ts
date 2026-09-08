export type Currency = 'KRW' | 'JPY' | 'USD'

export function requireCurrency(value: unknown): Currency {
  if (value !== 'KRW' && value !== 'JPY' && value !== 'USD') throw new Error('unsupported_currency')
  return value
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
  const firstGroup = whole.length % 3 || 3
  const groups = [whole.slice(0, firstGroup)]
  for (let index = firstGroup; index < whole.length; index += 3) groups.push(whole.slice(index, index + 3))
  const grouped = groups.join(',')
  if (currency === 'USD') return `${negative}$${grouped}.${digits.slice(-2)}`
  return `${negative}${grouped}${currency === 'KRW' ? '원' : '엔'}`
}
