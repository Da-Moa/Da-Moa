import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentPhase, benefitsPhase, heroPhase, isSectionTransitioning, nextSectionTransition } from '../../global/util/heroPhase.ts'

test('랜딩 화면의 소개 애니메이션 단계를 순서대로 진행한다', () => {
  assert.equal(heroPhase(0), 1)
  assert.equal(heroPhase(229), 1)
  assert.equal(heroPhase(230), 2)
  assert.equal(heroPhase(769), 2)
  assert.equal(heroPhase(770), 3)
})

test('간결한 혜택 화면 안에서 혜택 애니메이션을 완료한다', () => {
  assert.equal(benefitsPhase(0), 0)
  assert.equal(benefitsPhase(8), 1)
  assert.equal(benefitsPhase(99), 1)
  assert.equal(benefitsPhase(100), 2)
})

test('애니메이션 단계 변경 시 중간 단계를 건너뛰지 않는다', () => {
  assert.equal(adjacentPhase(2, 'up'), 1)
  assert.equal(adjacentPhase(1, 'up'), 1)
  assert.equal(adjacentPhase(1, 'down'), 2)
  assert.equal(adjacentPhase(2, 'down'), 2)
})

test('두 전환 애니메이션을 완료한 뒤 다음 방향 입력을 받는다', () => {
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
