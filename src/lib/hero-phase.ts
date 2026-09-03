export const HERO_STAGE_ONE_SCROLL = 18
export const HERO_STAGE_TWO_SCROLL = 230
export const HERO_EXIT_SCROLL = 770
export const BENEFITS_STAGE_ONE_SCROLL = 8
export const BENEFITS_STAGE_TWO_SCROLL = 100

export function heroPhase(scrolled: number) {
  if (scrolled >= HERO_EXIT_SCROLL) return 3
  if (scrolled >= HERO_STAGE_TWO_SCROLL) return 2
  return 1
}

export function benefitsPhase(scrolled: number) {
  if (scrolled >= BENEFITS_STAGE_TWO_SCROLL) return 2
  if (scrolled >= BENEFITS_STAGE_ONE_SCROLL) return 1
  return 0
}

export function adjacentPhase(current: number, direction: 'down' | 'up') {
  return direction === 'down' ? Math.min(2, current + 1) : Math.max(1, current - 1)
}

export type SectionTransitionState =
  | 'idle-hero'
  | 'hero-exit'
  | 'benefits-enter'
  | 'idle-benefits'
  | 'benefits-exit'
  | 'hero-enter'

export type SectionTransitionEvent = 'down' | 'up' | 'complete'

export function nextSectionTransition(state: SectionTransitionState, event: SectionTransitionEvent): SectionTransitionState {
  if (state === 'idle-hero' && event === 'down') return 'hero-exit'
  if (state === 'hero-exit' && event === 'complete') return 'benefits-enter'
  if (state === 'benefits-enter' && event === 'complete') return 'idle-benefits'
  if (state === 'idle-benefits' && event === 'up') return 'benefits-exit'
  if (state === 'benefits-exit' && event === 'complete') return 'hero-enter'
  if (state === 'hero-enter' && event === 'complete') return 'idle-hero'
  return state
}

export function isSectionTransitioning(state: SectionTransitionState) {
  return state !== 'idle-hero' && state !== 'idle-benefits'
}
