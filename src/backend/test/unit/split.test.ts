import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBase, finalizeSettlement, previewSettlement, validateCustomShares } from '../../../shared/domain/settle/split.ts'

const expense = (payerId: string, amountMinor: string, participantIds: string[], id = 'expense') => ({ id, payerId, amountMinor, participantIds })

test('결제자가 분담 대상으로 선택되면 분담하고 제외되면 전체 금액을 받는다', () => {
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

test('입력된 회차 안에서 서로 다른 결제자의 금액을 결정적인 순서로 상계한다', () => {
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

test('기본 분배는 나머지를 미루고 최종 추첨은 서로 다른 수령자를 선택한다', () => {
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

test('미리보기가 기본 분배를 상계하고 나머지는 배정하지 않는다', () => {
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

test('개별 분배가 추첨 없이 미리보기·최종 정산의 지정 금액을 유지한다', () => {
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

test('균등·개별 분배가 섞여도 금액을 보존하고 균등 분배의 나머지만 미룬다', () => {
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

test('개별 분배의 누락·중복·잘못된 형식·합계 불일치를 거부한다', () => {
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

test('잘못된 입력으로 불완전하거나 중복된 원장을 만들지 않는다', () => {
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

test('서로 다른 통화의 잔액·송금·남은 나머지를 상계하지 않는다', async () => {
  const { finalizeCurrencySettlement, previewCurrencySettlement } = await import('../../../shared/domain/settle/split.ts')
  const expenses = [
    { id: 'krw', currency: 'KRW' as const, payerId: 'B', amountMinor: '1001', participantIds: ['A', 'B'] },
    { id: 'jpy', currency: 'JPY' as const, payerId: 'A', amountMinor: '201', participantIds: ['A', 'B'] },
    { id: 'usd', currency: 'USD' as const, payerId: 'B', amountMinor: '31', participantIds: ['A', 'B'] },
  ]
  const preview = previewCurrencySettlement(expenses, ['A', 'B'])
  assert.deepEqual(preview.pendingRemainders, [
    { currency: 'JPY', amountMinor: '1' }, { currency: 'KRW', amountMinor: '1' }, { currency: 'USD', amountMinor: '1' },
  ])
  assert.deepEqual(preview.transfers, [
    { currency: 'JPY', senderId: 'B', receiverId: 'A', amountMinor: '100' },
    { currency: 'KRW', senderId: 'A', receiverId: 'B', amountMinor: '500' },
    { currency: 'USD', senderId: 'A', receiverId: 'B', amountMinor: '15' },
  ])
  const final = finalizeCurrencySettlement(expenses, ['A', 'B'], () => 0)
  for (const currency of ['KRW', 'JPY', 'USD']) {
    const balances = final.balances.filter(balance => balance.currency === currency)
    assert.equal(balances.reduce((sum, balance) => sum + BigInt(balance.balanceMinor), 0n), 0n)
    for (const balance of balances) {
      const transfers = final.transfers.filter(transfer => transfer.currency === currency)
      const sent = transfers.filter(transfer => transfer.senderId === balance.userId).reduce((sum, transfer) => sum + BigInt(transfer.amountMinor), 0n)
      const received = transfers.filter(transfer => transfer.receiverId === balance.userId).reduce((sum, transfer) => sum + BigInt(transfer.amountMinor), 0n)
      assert.equal(sent - received, BigInt(balance.balanceMinor))
    }
  }
  assert.throws(() => finalizeCurrencySettlement([...expenses, ...expenses], ['A', 'B']), /invalid_expenses/)
  assert.throws(() => finalizeCurrencySettlement(['KRW', 'JPY', 'USD', 'EUR', 'CNY', 'THB'].map((currency, index) => ({ ...expenses[0], id: String(index), currency: currency as 'KRW' })), ['A', 'B']), /round_currency_limit_exceeded/)
})
