import assert from 'node:assert/strict'
import test from 'node:test'
import { splitAmounts } from './split.ts'

test('splitAmounts preserves the total and fairly distributes the remainder', () => {
  const amounts = splitAmounts(10, 3)

  assert.deepEqual(amounts, [4, 3, 3])
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 10)
})
