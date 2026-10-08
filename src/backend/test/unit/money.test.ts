import assert from 'node:assert/strict'
import test from 'node:test'
import { amountInputPattern, CURRENCY_CODES, expenseInputMaximum, formatAmountInput, formatMoney, minorLimit, minorToAmount, parseAmount, requireCurrency } from '../../../shared/domain/settle/money.ts'

test('amount input adds thousands separators while preserving partial USD decimals', () => {
  assert.equal(formatAmountInput('1234567', 'KRW'), '1,234,567')
  assert.equal(formatAmountInput('1,234,567', 'JPY'), '1,234,567')
  assert.equal(formatAmountInput('9007199254740993.01', 'USD'), '9,007,199,254,740,993.01')
  assert.equal(formatAmountInput('.5', 'USD'), null)
  assert.equal(formatAmountInput('1.', 'USD'), '1.')
  assert.equal(formatAmountInput('1.234', 'USD'), null)
  assert.equal(formatAmountInput('-1', 'KRW'), null)
})

test('expense input clamps to the per-expense and remaining round limits', () => {
  for (const currency of ['KRW', 'JPY'] as const) {
    const maximum = expenseInputMaximum('0', null, currency)
    assert.equal(maximum, 100_000_000n)
    assert.equal(formatAmountInput('100000000', currency, maximum), '100,000,000')
    assert.equal(formatAmountInput('100000001', currency, maximum), '100,000,000')
    assert.equal(formatAmountInput('9'.repeat(300), currency, maximum), '100,000,000')
    assert.equal(formatAmountInput('20', currency, expenseInputMaximum('999999990', null, currency)), '10')
    assert.equal(formatAmountInput('20', currency, expenseInputMaximum('999999990', '5', currency)), '15')
  }
  const usdMaximum = expenseInputMaximum('0', null, 'USD')
  assert.equal(usdMaximum, 10_000_000_000n)
  assert.equal(formatAmountInput('100000000.00', 'USD', usdMaximum), '100,000,000.00')
  assert.equal(formatAmountInput('100000000.01', 'USD', usdMaximum), '100,000,000.00')
  assert.equal(formatAmountInput('0.02', 'USD', expenseInputMaximum('99999999999', null, 'USD')), '0.01')
  assert.equal(formatAmountInput('0.07', 'USD', expenseInputMaximum('99999999999', '5', 'USD')), '0.06')
  assert.equal(formatAmountInput('1.', 'USD', usdMaximum), '1.')
})

test('currency decimals and amounts beyond Number precision remain exact', () => {
  assert.equal(parseAmount('6000', 'KRW'), 6000n)
  assert.equal(parseAmount('1', 'JPY'), 1n)
  assert.equal(parseAmount('60', 'USD'), 6000n)
  assert.equal(parseAmount('60.0', 'USD'), 6000n)
  assert.equal(parseAmount('60.01', 'USD'), 6001n)
  assert.equal(parseAmount('0.01', 'USD'), 1n)
  assert.equal(parseAmount('9007199254740993', 'KRW'), 9007199254740993n)
  assert.equal(parseAmount('9007199254740993.01', 'USD'), 900719925474099301n)
  assert.equal(formatMoney('9007199254740993', 'KRW'), '9,007,199,254,740,993원')
  assert.equal(formatMoney('900719925474099301', 'USD'), '$9,007,199,254,740,993.01')
  assert.equal(formatMoney('-5000', 'KRW'), '-5,000원')
  assert.equal(formatMoney('1', 'USD'), '$0.01')
  assert.equal(formatMoney('-1', 'USD'), '-$0.01')
  assert.equal(formatMoney('0', 'JPY'), '0엔')
  assert.equal(formatMoney('-0', 'USD'), '$0.00')
  assert.equal(formatMoney('9'.repeat(300), 'JPY'), `${Array(100).fill('999').join(',')}엔`)
})

test('money boundaries reject invalid input instead of rounding or coercing', () => {
  for (const currency of CURRENCY_CODES) {
    for (const value of [0, 6000, NaN, Infinity, null, undefined, {}, '', ' ', ' 1', '1 ', '1\n', '1\r', '\t1', '0', '000', '-1', '+1', 'NaN', 'Infinity', '1e3', '1,000', '.01', '1.']) {
      assert.throws(() => parseAmount(value, currency), /invalid_amount/)
    }
  }
  for (const value of ['1.0', '0.01']) {
    assert.throws(() => parseAmount(value, 'KRW'), /invalid_amount/)
    assert.throws(() => parseAmount(value, 'JPY'), /invalid_amount/)
  }
  for (const value of ['1.001', '0.000', '0.00']) assert.throws(() => parseAmount(value, 'USD'), /invalid_amount/)
  for (const value of ['XXX', 'krw', '', null, {}, 'constructor', 'toString', '__proto__']) assert.throws(() => requireCurrency(value), /unsupported_currency/)
  for (const value of ['1.5', 'NaN', 'Infinity', '', '1e3']) assert.throws(() => formatMoney(value, 'USD'), /invalid_amount/)
})

test('every supported currency preserves its ISO minor units through entry, limits and editing', () => {
  for (const currency of CURRENCY_CODES) {
    const wholeUnits = ['KRW', 'JPY', 'VND'].includes(currency)
    const amount = wholeUnits ? '9007199254740993' : '9007199254740993.01'
    const expected = wholeUnits ? 9007199254740993n : 900719925474099301n
    assert.equal(requireCurrency(currency), currency)
    assert.equal(parseAmount(amount, currency), expected)
    assert.equal(minorToAmount(expected.toString(), currency), amount)
    assert.equal(minorToAmount((-expected).toString(), currency), `-${amount}`)
    assert.equal(minorLimit(1n, currency), wholeUnits ? 1n : 100n)
    const input = formatAmountInput(amount, currency)!
    assert.ok(new RegExp(`^(?:${amountInputPattern(currency)})$`).test(input), currency)
    assert.equal(parseAmount(input.replace(/,/g, ''), currency), expected)
    assert.equal(formatAmountInput('1.', currency), wholeUnits ? null : '1.')
    assert.throws(() => parseAmount(wholeUnits ? '1.01' : '1.001', currency), /invalid_amount/)
    const maximum = expenseInputMaximum('0', null, currency)
    assert.equal(maximum, wholeUnits ? 100_000_000n : 10_000_000_000n)
    assert.equal(formatAmountInput(amount, currency, maximum), wholeUnits ? '100,000,000' : '100,000,000.00')
    const roundMaximum = wholeUnits ? 1_000_000_000n : 100_000_000_000n
    assert.equal(expenseInputMaximum((roundMaximum - 1n).toString(), '5', currency), 6n)
    assert.equal(formatAmountInput(amount, currency, 1n), wholeUnits ? '1' : '0.01')
    assert.equal(formatAmountInput('1', currency, 0n), wholeUnits ? '0' : '0.00')
    assert.equal(parseAmount(wholeUnits ? '1' : '0.01', currency), 1n)
    if (!['KRW', 'USD', 'JPY'].includes(currency)) {
      assert.equal(formatMoney(expected.toString(), currency), `${wholeUnits ? '9,007,199,254,740,993' : '9,007,199,254,740,993.01'} ${currency}`)
      assert.equal(formatMoney('-1', currency), `${wholeUnits ? '-1' : '-0.01'} ${currency}`)
    }
  }
})
