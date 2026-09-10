import assert from 'node:assert/strict'
import test from 'node:test'
import { collapseMovesByPlace, digitSequence } from './money-animation.ts'

test('digit reels include every value and keep inner zero places until leading places finish', () => {
  assert.deepEqual(digitSequence('9', undefined, 'down'), ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0'])
  assert.deepEqual(digitSequence('0', '5', 'down'), ['0', '9', '8', '7', '6', '5'])
  assert.deepEqual([...collapseMovesByPlace([[4, 9], [3, 1], [2, 0], [1, 0]])], [[4, 9], [3, 9], [2, 9], [1, 9]])
})
