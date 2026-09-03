import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentPhase, benefitsPhase, heroPhase, isSectionTransitioning, nextSectionTransition } from './hero-phase.ts'

test('heroPhase advances through the landing sequence', () => {
  assert.equal(heroPhase(0), 1)
  assert.equal(heroPhase(229), 1)
  assert.equal(heroPhase(230), 2)
  assert.equal(heroPhase(769), 2)
  assert.equal(heroPhase(770), 3)
})

test('benefitsPhase completes within the compact benefits scene', () => {
  assert.equal(benefitsPhase(0), 0)
  assert.equal(benefitsPhase(8), 1)
  assert.equal(benefitsPhase(99), 1)
  assert.equal(benefitsPhase(100), 2)
})

test('phase changes never skip an intermediate section stage', () => {
  assert.equal(adjacentPhase(2, 'up'), 1)
  assert.equal(adjacentPhase(1, 'up'), 1)
  assert.equal(adjacentPhase(1, 'down'), 2)
  assert.equal(adjacentPhase(2, 'down'), 2)
})

test('section transitions finish both animations before accepting another direction', () => {
  let state = nextSectionTransition('idle-hero', 'down')
  assert.equal(state, 'hero-exit')
  assert.equal(isSectionTransitioning(state), true)
  assert.equal(nextSectionTransition(state, 'up'), state)

  state = nextSectionTransition(state, 'complete')
  assert.equal(state, 'benefits-enter')
  assert.equal(nextSectionTransition(state, 'down'), state)
  state = nextSectionTransition(state, 'complete')
  assert.equal(state, 'idle-benefits')

  state = nextSectionTransition(state, 'up')
  assert.equal(state, 'benefits-exit')
  assert.equal(nextSectionTransition(state, 'down'), state)
  state = nextSectionTransition(state, 'complete')
  assert.equal(state, 'hero-enter')
  state = nextSectionTransition(state, 'complete')
  assert.equal(state, 'idle-hero')
})
