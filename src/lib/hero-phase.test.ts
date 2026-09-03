import assert from 'node:assert/strict'
import test from 'node:test'
import { heroPhase } from './hero-phase.ts'

test('heroPhase advances through the landing sequence', () => {
  assert.equal(heroPhase(0), 0)
  assert.equal(heroPhase(18), 1)
  assert.equal(heroPhase(229), 1)
  assert.equal(heroPhase(230), 2)
})
