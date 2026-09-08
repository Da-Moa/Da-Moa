import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBase, finalizeSettlement } from './split.ts'

const expense = (payerId: string, amountMinor: string, participantIds: string[], id = 'expense') => ({ id, payerId, amountMinor, participantIds })

test('payer remains a burden member when selected, and receives the full amount when not selected', () => {
  const shared = finalizeSettlement([expense('B', '6000', ['A', 'B', 'C'])], ['A', 'B', 'C'])
  assert.deepEqual(shared.balances.map(row => row.balanceMinor), ['2000', '-4000', '2000'])
  assert.deepEqual(shared.transfers, [
    { senderId: 'A', receiverId: 'B', amountMinor: '2000' },
    { senderId: 'C', receiverId: 'B', amountMinor: '2000' },
  ])
  const separate = finalizeSettlement([expense('B', '6000', ['A', 'C'])], ['A', 'B', 'C'])
  assert.deepEqual(separate.balances.map(row => row.balanceMinor), ['3000', '-6000', '3000'])
  assert.equal(separate.balances[1].burdenMinor, '0')
  assert.deepEqual(separate.transfers.map(row => row.amountMinor), ['3000', '3000'])
})

test('different payers are netted deterministically within the supplied round', () => {
  const expenses = [expense('A', '60000', ['A', 'B', 'C'], 'one'), expense('B', '30000', ['A', 'B'], 'two')]
  const result = finalizeSettlement(expenses, ['A', 'B', 'C'])
  assert.deepEqual(result.balances.map(row => row.balanceMinor), ['-25000', '5000', '20000'])
  assert.deepEqual(result.transfers, [
    { senderId: 'B', receiverId: 'A', amountMinor: '5000' },
    { senderId: 'C', receiverId: 'A', amountMinor: '20000' },
  ])
  assert.deepEqual(finalizeSettlement([...expenses].reverse(), ['C', 'B', 'A']), result)
  assert.deepEqual(finalizeSettlement([expense('A', '10', ['A'], 'one'), expense('B', '10', ['B'], 'two')], ['A', 'B']).transfers, [])
  assert.deepEqual(finalizeSettlement([
    expense('A', '90', ['C', 'D'], 'one'), expense('B', '60', ['C', 'D'], 'two'),
  ], ['E', 'D', 'C', 'B', 'A']).transfers, [
    { senderId: 'C', receiverId: 'A', amountMinor: '75' },
    { senderId: 'D', receiverId: 'A', amountMinor: '15' },
    { senderId: 'D', receiverId: 'B', amountMinor: '60' },
  ])
})

test('base allocation defers remainder and final draw selects different recipients', () => {
  assert.deepEqual(calculateBase(10000n, 3), { base: 3333n, remainder: 1 })
  assert.throws(() => finalizeSettlement([expense('A', '10000', ['A', 'B', 'C'])], ['A', 'B', 'C']), /remainder_draw_required/)
  for (const total of ['10000', '10001', '1', '1000', '9007199254740993']) {
    for (const draw of [() => 0, (max: number) => max - 1]) {
      const result = finalizeSettlement([expense('B', total, ['A', 'B', 'C'])], ['A', 'B', 'C'], draw)
      assert.equal(result.shares.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n), BigInt(total))
      assert.equal(result.shares.filter(row => row.receivedRemainder).length, Number(BigInt(total) % 3n))
      const amounts = result.shares.map(row => BigInt(row.amountMinor)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1n)
      assert.equal(result.balances.reduce((sum, row) => sum + BigInt(row.balanceMinor), 0n), 0n)
      assert.ok(result.transfers.every(row => BigInt(row.amountMinor) > 0n && row.senderId !== row.receiverId))
      for (const balance of result.balances) {
        const outgoing = result.transfers.filter(row => row.senderId === balance.userId).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)
        const incoming = result.transfers.filter(row => row.receiverId === balance.userId).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)
        assert.equal(outgoing - incoming, BigInt(balance.balanceMinor))
      }
    }
  }
})

test('invalid inputs cannot create incomplete or duplicate ledgers', () => {
  for (const count of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => calculateBase(1n, count), /invalid_participants/)
  for (const total of [0n, -1n]) assert.throws(() => calculateBase(total, 2), /invalid_amount/)
  for (const participants of [[], ['A', 'A'], ['A', 'outsider']]) {
    assert.throws(() => finalizeSettlement([expense('B', '6000', participants)], ['A', 'B']), /invalid_participants/)
  }
  assert.throws(() => finalizeSettlement([expense('outsider', '6000', ['A'])], ['A', 'B']), /invalid_participants/)
  assert.throws(() => finalizeSettlement([expense('A', '6000', ['A'])], ['A', 'A']), /invalid_participants/)
  assert.throws(() => finalizeSettlement([], ['A', 'B']), /empty_expenses/)
  assert.throws(() => finalizeSettlement([expense('A', '1', ['A']), expense('A', '1', ['A'])], ['A', 'B']), /invalid_expenses/)
  for (const amount of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
    assert.throws(() => finalizeSettlement([expense('A', amount, ['A'])], ['A', 'B']), /invalid_amount/)
  }
  for (const draw of [() => -1, (max: number) => max, () => 0.5, () => NaN]) {
    assert.throws(() => finalizeSettlement([expense('A', '1', ['A', 'B'])], ['A', 'B'], draw), /invalid_draw/)
  }
})
