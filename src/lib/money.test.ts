import assert from 'node:assert/strict'
import test from 'node:test'
import { expenseInputMaximum, formatAmountInput, formatMoney, parseAmount, requireCurrency } from './money.ts'

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
  for (const currency of ['KRW', 'JPY', 'USD'] as const) {
    for (const value of [0, 6000, NaN, Infinity, null, undefined, {}, '', ' ', ' 1', '1 ', '1\n', '1\r', '\t1', '0', '000', '-1', '+1', 'NaN', 'Infinity', '1e3', '1,000', '.01', '1.']) {
      assert.throws(() => parseAmount(value, currency), /invalid_amount/)
    }
  }
  for (const value of ['1.0', '0.01']) {
    assert.throws(() => parseAmount(value, 'KRW'), /invalid_amount/)
    assert.throws(() => parseAmount(value, 'JPY'), /invalid_amount/)
  }
  for (const value of ['1.001', '0.000', '0.00']) assert.throws(() => parseAmount(value, 'USD'), /invalid_amount/)
  for (const value of ['EUR', 'krw', '', null]) assert.throws(() => requireCurrency(value), /unsupported_currency/)
  for (const value of ['1.5', 'NaN', 'Infinity', '', '1e3']) assert.throws(() => formatMoney(value, 'USD'), /invalid_amount/)
})
