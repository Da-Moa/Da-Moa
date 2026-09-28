import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBase, finalizeSettlement, previewSettlement, validateCustomShares } from './split.ts'

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

test('preview nets base shares and leaves every remainder unassigned', () => {
  const shared = previewSettlement([expense('B', '6001', ['A', 'B', 'C'])], ['A', 'B', 'C'])
  assert.equal(shared.pendingRemainderMinor, '1')
  assert.deepEqual(shared.transfers, [
    { senderId: 'A', receiverId: 'B', amountMinor: '2000' },
    { senderId: 'C', receiverId: 'B', amountMinor: '2000' },
  ])

  const separate = previewSettlement([expense('B', '6001', ['A', 'C'])], ['A', 'B', 'C'])
  assert.equal(separate.pendingRemainderMinor, '1')
  assert.deepEqual(separate.transfers.map(row => row.amountMinor), ['3000', '3000'])

  const tiny = previewSettlement([expense('A', '1', ['A', 'B', 'C'])], ['A', 'B', 'C'])
  assert.equal(tiny.pendingRemainderMinor, '1')
  assert.deepEqual(tiny.transfers, [])
  assert.equal(tiny.balances.reduce((sum, row) => sum + BigInt(row.balanceMinor), 0n), 0n)
})

test('custom shares preserve assigned amounts in preview and final settlement without a draw', () => {
  const custom = {
    ...expense('B', '10', ['C', 'A', 'B']), splitMode: 'CUSTOM' as const,
    shares: [{ userId: 'C', assignedAmountMinor: '6' }, { userId: 'A', assignedAmountMinor: '1' }, { userId: 'B', assignedAmountMinor: '3' }],
  }
  const result = finalizeSettlement([custom], ['A', 'B', 'C'])
  assert.deepEqual(result.balances, [
    { userId: 'A', paidMinor: '0', burdenMinor: '1', balanceMinor: '1' },
    { userId: 'B', paidMinor: '10', burdenMinor: '3', balanceMinor: '-7' },
    { userId: 'C', paidMinor: '0', burdenMinor: '6', balanceMinor: '6' },
  ])
  assert.deepEqual(result.transfers, [
    { senderId: 'A', receiverId: 'B', amountMinor: '1' },
    { senderId: 'C', receiverId: 'B', amountMinor: '6' },
  ])
  assert.ok(result.shares.every(share => !share.receivedRemainder))
  assert.deepEqual(previewSettlement([custom], ['A', 'B', 'C']), { ...result, pendingRemainderMinor: '0' })
  assert.deepEqual(finalizeSettlement([custom], ['C', 'B', 'A'], () => assert.fail('custom shares must not draw')), result)

  const separate = finalizeSettlement([{
    ...expense('B', '9007199254740993', ['A', 'C']), splitMode: 'CUSTOM',
    shares: [{ userId: 'A', assignedAmountMinor: '9007199254740992' }, { userId: 'C', assignedAmountMinor: '1' }],
  }], ['A', 'B', 'C'])
  assert.deepEqual(separate.balances.map(row => row.balanceMinor), ['9007199254740992', '-9007199254740993', '1'])
})

test('mixed equal and custom shares conserve money and defer only the equal remainder', () => {
  const expenses = [
    { ...expense('A', '10', ['A', 'B', 'C'], 'equal'), splitMode: 'ALL' as const },
    { ...expense('B', '11', ['A', 'C'], 'custom'), splitMode: 'CUSTOM' as const,
      shares: [{ userId: 'A', assignedAmountMinor: '2' }, { userId: 'C', assignedAmountMinor: '9' }] },
  ]
  const preview = previewSettlement(expenses, ['A', 'B', 'C'])
  assert.equal(preview.pendingRemainderMinor, '1')
  assert.deepEqual(preview.balances.map(row => row.balanceMinor), ['-4', '-8', '12'])
  assert.throws(() => finalizeSettlement(expenses, ['A', 'B', 'C']), /remainder_draw_required/)
  let draws = 0
  const final = finalizeSettlement(expenses, ['A', 'B', 'C'], max => { draws++; return max - 1 })
  assert.equal(draws, 1)
  assert.deepEqual(final.balances.map(row => row.balanceMinor), ['-5', '-8', '13'])
  assert.deepEqual(final.shares.filter(share => share.expenseId === 'custom'), preview.shares.filter(share => share.expenseId === 'custom'))
  assert.equal(final.shares.reduce((sum, share) => sum + BigInt(share.amountMinor), 0n), 21n)
  for (const result of [preview, final]) {
    assert.equal(result.balances.reduce((sum, row) => sum + BigInt(row.balanceMinor), 0n), 0n)
    assert.equal(result.shares.reduce((sum, share) => sum + BigInt(share.amountMinor), 0n), result.balances.reduce((sum, row) => sum + BigInt(row.paidMinor), 0n))
    for (const balance of result.balances) {
      const outgoing = result.transfers.filter(row => row.senderId === balance.userId).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)
      const incoming = result.transfers.filter(row => row.receiverId === balance.userId).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)
      assert.equal(outgoing - incoming, BigInt(balance.balanceMinor))
    }
  }
})

test('custom shares reject missing, duplicate, malformed or mismatched assignments', () => {
  const shares = [{ userId: 'A', assignedAmountMinor: '1' }, { userId: 'B', assignedAmountMinor: '2' }]
  assert.deepEqual(validateCustomShares(3n, ['B', 'A'], shares), new Map([['A', 1n], ['B', 2n]]))
  for (const invalid of [undefined, null, {}, [], [shares[0]], [shares[0], shares[0]], [shares[0], { ...shares[1], userId: 'outsider' }], [shares[0], null]]) {
    assert.throws(() => validateCustomShares(3n, ['A', 'B'], invalid as typeof shares), /invalid_participants/)
  }
  for (const participants of [[], ['A', 'A'], ['A', ''], ['A', 1], undefined]) {
    assert.throws(() => validateCustomShares(3n, participants as string[], shares), /invalid_participants/)
  }
  for (const amount of [undefined, null, '', '0', '-1', '1.5', '1e3', ' 1', '1 ', '1,000', 'NaN', 'Infinity', 1]) {
    const custom = { ...expense('B', '3', ['A', 'B']), splitMode: 'CUSTOM' as const,
      shares: [{ userId: 'A', assignedAmountMinor: amount as string }, shares[1]] }
    assert.throws(() => validateCustomShares(3n, custom.participantIds, custom.shares), /invalid_amount/)
    assert.throws(() => previewSettlement([custom], ['A', 'B']), /invalid_amount/)
    assert.throws(() => finalizeSettlement([custom], ['A', 'B']), /invalid_amount/)
  }
  for (const total of [0n, -1n]) assert.throws(() => validateCustomShares(total, ['A', 'B'], shares), /invalid_amount/)
  for (const total of ['2', '4']) {
    const custom = { ...expense('B', total, ['A', 'B']), splitMode: 'CUSTOM' as const, shares }
    assert.throws(() => previewSettlement([custom], ['A', 'B']), /custom_share_total_mismatch/)
    assert.throws(() => finalizeSettlement([custom], ['A', 'B']), /custom_share_total_mismatch/)
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
