'use client'

import { useEffect, useRef } from 'react'
import { ReceiptText, Users, WalletCards } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import hero from '../assets/hero.png'
import {
  adjacentPhase,
  BENEFITS_STAGE_ONE_SCROLL,
  BENEFITS_STAGE_TWO_SCROLL,
  benefitsPhase,
  HERO_EXIT_SCROLL,
  HERO_STAGE_ONE_SCROLL,
  HERO_STAGE_TWO_SCROLL,
  heroPhase,
  isSectionTransitioning,
  nextSectionTransition,
  type SectionTransitionState,
} from '../lib/hero-phase'

const benefits = [
  { title: '지출과 증빙을 함께', description: '금액을 입력하고 영수증을 보관해요', Icon: ReceiptText },
  { title: '함께 쓴 만큼 1/N', description: '결제자와 부담할 멤버를 골라요', Icon: Users },
  { title: '링크 하나로', description: '친구들에게 정산을 요청해요', Icon: WalletCards },
]

export default function LandingPage() {
  const heroSceneRef = useRef<HTMLElement>(null)
  const benefitsSceneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const scene = heroSceneRef.current
    const benefitsScene = benefitsSceneRef.current
    if (!scene || !benefitsScene) return

    const heroPanel = scene.querySelector<HTMLElement>('.landing-hero')
    const benefitsPanel = benefitsScene.querySelector<HTMLElement>('.landing-benefits')
    const header = document.querySelector<HTMLElement>('.landing-header')
    if (!heroPanel || !benefitsPanel || !header) return

    const root = document.documentElement
    const animations = new Set<Animation>()
    let animationFrame = 0
    let disposed = false
    let lastScrollY = window.scrollY
    let lockedScrollY: number | undefined
    let initialEntering = true
    let stageTransitioning = false
    let transitionState: SectionTransitionState = 'idle-hero'

    const isInteractionLocked = () => initialEntering || stageTransitioning || isSectionTransitioning(transitionState)

    const lockScroll = () => {
      lockedScrollY = window.scrollY
      root.classList.add('landing-transition-locked')
    }

    const unlockScroll = () => {
      if (disposed) return
      lastScrollY = window.scrollY
      lockedScrollY = undefined
      root.classList.remove('landing-transition-locked')
    }

    const fade = async (element: HTMLElement, from: number, to: number, settle?: () => void) => {
      const animation = element.animate(
        [{ opacity: from }, { opacity: to }],
        { duration: 500, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' },
      )
      animations.add(animation)

      let finished = false
      try {
        await animation.finished
        finished = true
      } catch {
        // Cleanup cancels active animations when the page unmounts.
      } finally {
        animations.delete(animation)
      }

      if (finished && !disposed) settle?.()
      animation.cancel()
      return finished && !disposed
    }

    const runInitialEntry = async () => {
      lockScroll()
      try {
        await fade(heroPanel, 0, 1, () => heroPanel.classList.remove('landing-hero-initial'))
      } finally {
        initialEntering = false
        unlockScroll()
      }
    }

    const scrollToPosition = (top: number) => {
      lockedScrollY = Math.max(0, top)
      window.scrollTo({ top: lockedScrollY, behavior: 'auto' })
    }

    const scrollToBenefitsPhase = (phase: number) => {
      const progress = phase === 2 ? BENEFITS_STAGE_TWO_SCROLL : BENEFITS_STAGE_ONE_SCROLL
      const top = window.scrollY + benefitsScene.getBoundingClientRect().top - header.getBoundingClientRect().bottom + progress
      scrollToPosition(top)
    }

    const scrollToHeroExitEdge = () => {
      const top = window.scrollY + scene.getBoundingClientRect().top + HERO_EXIT_SCROLL - 1
      scrollToPosition(top)
    }

    const scrollToHeroPhase = (phase: number) => {
      const progress = phase === 2 ? HERO_STAGE_TWO_SCROLL : HERO_STAGE_ONE_SCROLL
      const top = window.scrollY + scene.getBoundingClientRect().top + progress
      scrollToPosition(top)
    }

    const waitForStageAnimations = async (panel: HTMLElement) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const running = panel.getAnimations({ subtree: true })
      await Promise.allSettled(running.map((animation) => animation.finished))
      return !disposed
    }

    const runStageTransition = async (section: 'hero' | 'benefits', phase: number) => {
      if (isInteractionLocked()) return

      stageTransitioning = true
      lockScroll()
      const panel = section === 'hero' ? heroPanel : benefitsPanel
      const sectionElement = section === 'hero' ? scene : benefitsScene
      const transitionClass = section === 'hero' ? 'landing-hero-transitioning' : 'landing-benefits-transitioning'

      panel.classList.add(transitionClass)
      if (section === 'hero') scrollToHeroPhase(phase)
      else scrollToBenefitsPhase(phase)
      sectionElement.dataset.phase = String(phase)

      try {
        await waitForStageAnimations(panel)
      } finally {
        panel.classList.remove(transitionClass)
        stageTransitioning = false
        unlockScroll()
      }
    }

    const runSectionTransition = async (direction: 'down' | 'up') => {
      const startedState = nextSectionTransition(transitionState, direction)
      if (startedState === transitionState) return

      transitionState = startedState
      lockScroll()

      try {
        if (direction === 'down') {
          heroPanel.classList.add('landing-hero-transitioning')
          if (!await fade(heroPanel, 1, 0, () => { scene.dataset.phase = '3' })) return

          transitionState = nextSectionTransition(transitionState, 'complete')
          scrollToBenefitsPhase(1)
          benefitsScene.dataset.phase = '1'
          benefitsPanel.classList.add('landing-benefits-transitioning')
          const stageAnimations = waitForStageAnimations(benefitsPanel)
          if (!await fade(benefitsPanel, 0, 1)) return
          if (!await stageAnimations) return
          transitionState = nextSectionTransition(transitionState, 'complete')
        } else {
          benefitsPanel.classList.add('landing-benefits-transitioning')
          if (!await fade(benefitsPanel, 1, 0, () => { benefitsScene.dataset.phase = '0' })) return

          transitionState = nextSectionTransition(transitionState, 'complete')
          scrollToHeroExitEdge()
          scene.dataset.phase = '2'
          heroPanel.classList.add('landing-hero-transitioning')
          const stageAnimations = waitForStageAnimations(heroPanel)
          if (!await fade(heroPanel, 0, 1)) return
          if (!await stageAnimations) return
          transitionState = nextSectionTransition(transitionState, 'complete')
        }
      } finally {
        heroPanel.classList.remove('landing-hero-transitioning')
        benefitsPanel.classList.remove('landing-benefits-transitioning')
        unlockScroll()
      }
    }

    const updatePhase = () => {
      animationFrame = 0
      if (isInteractionLocked()) return

      const scrollY = window.scrollY
      const direction = scrollY > lastScrollY ? 'down' : scrollY < lastScrollY ? 'up' : undefined
      lastScrollY = scrollY
      if (!direction) return

      if (transitionState === 'idle-hero') {
        const targetHeroPhase = heroPhase(Math.max(0, -scene.getBoundingClientRect().top))
        const currentHeroPhase = Number(scene.dataset.phase)

        if (direction === 'down' && targetHeroPhase > currentHeroPhase && currentHeroPhase < 2) {
          void runStageTransition('hero', adjacentPhase(currentHeroPhase, direction))
        } else if (direction === 'up' && targetHeroPhase < currentHeroPhase && currentHeroPhase > 1) {
          void runStageTransition('hero', adjacentPhase(currentHeroPhase, direction))
        } else if (direction === 'down' && currentHeroPhase === 2 && targetHeroPhase === 3) {
          void runSectionTransition('down')
        }
        return
      }

      const progress = Math.max(0, header.getBoundingClientRect().bottom - benefitsScene.getBoundingClientRect().top)
      const nextBenefitsPhase = benefitsPhase(progress)
      const currentBenefitsPhase = Number(benefitsScene.dataset.phase)

      if (direction === 'up' && nextBenefitsPhase < currentBenefitsPhase && currentBenefitsPhase > 1) {
        void runStageTransition('benefits', adjacentPhase(currentBenefitsPhase, direction))
      } else if (direction === 'down' && nextBenefitsPhase > currentBenefitsPhase) {
        void runStageTransition('benefits', adjacentPhase(currentBenefitsPhase, direction))
      } else if (direction === 'up' && currentBenefitsPhase === 1 && nextBenefitsPhase === 0) {
        void runSectionTransition('up')
      }
    }

    const onScroll = () => {
      if (isInteractionLocked()) {
        if (lockedScrollY !== undefined && Math.abs(window.scrollY - lockedScrollY) > 1) {
          window.scrollTo({ top: lockedScrollY, behavior: 'auto' })
        }
        return
      }
      if (!animationFrame) animationFrame = requestAnimationFrame(updatePhase)
    }

    const preventScrollInput = (event: Event) => {
      if (isInteractionLocked() && event.cancelable) event.preventDefault()
    }

    const preventScrollKey = (event: KeyboardEvent) => {
      if (
        isInteractionLocked()
        && ['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)
      ) event.preventDefault()
    }

    root.classList.add('hero-sequence-ready')
    scene.dataset.phase = String(Math.min(2, heroPhase(Math.max(0, -scene.getBoundingClientRect().top))))
    const initialBenefitsPhase = benefitsPhase(
      Math.max(0, header.getBoundingClientRect().bottom - benefitsScene.getBoundingClientRect().top),
    )
    if (initialBenefitsPhase > 0) {
      transitionState = 'idle-benefits'
      scene.dataset.phase = '3'
      benefitsScene.dataset.phase = String(initialBenefitsPhase)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', preventScrollInput, { passive: false })
    window.addEventListener('touchmove', preventScrollInput, { passive: false })
    window.addEventListener('keydown', preventScrollKey)

    if (initialBenefitsPhase === 0 && window.scrollY === 0) void runInitialEntry()
    else {
      initialEntering = false
      heroPanel.classList.remove('landing-hero-initial')
    }

    return () => {
      disposed = true
      cancelAnimationFrame(animationFrame)
      animations.forEach((animation) => animation.cancel())
      heroPanel.classList.remove('landing-hero-transitioning')
      benefitsPanel.classList.remove('landing-benefits-transitioning')
      root.classList.remove('hero-sequence-ready', 'landing-transition-locked')
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', preventScrollInput)
      window.removeEventListener('touchmove', preventScrollInput)
      window.removeEventListener('keydown', preventScrollKey)
    }
  }, [])

  return (
    <main className="landing-page">
      <header className="landing-header">
        <Link className="landing-brand" href="/" aria-label="다모아 홈">
          <img alt="다모아" height="34" src="/logo/da-moa-trans.png" width="41" />
        </Link>
        <Link className="landing-login" href="/login">로그인</Link>
      </header>

      <section className="landing-hero-scene" aria-labelledby="landing-heading" data-phase="1" ref={heroSceneRef}>
        <div className="landing-hero landing-hero-initial">
          <div className="landing-hero-copy">
            <p>더치페이, 이제 가볍게</p>
            <h1 id="landing-heading">모임비 정산,<br /><span>다모아로 끝내요</span></h1>
            <span>지출 기록부터 개인별 금액 안내까지<br />모임의 정산을 한 곳에서</span>
          </div>
          <Image alt="정산 과정을 상징하는 카드 일러스트" className="landing-hero-image" priority src={hero} />
          <div className="landing-amount-card" aria-hidden="true">
            <small>1인당 낼 금액</small>
            <strong>14,575<span>원</span></strong>
            <em>4명이 함께해요</em>
          </div>
        </div>
      </section>

      <div className="landing-section-reset" aria-hidden="true" />

      <div className="landing-benefits-scene" data-phase="0" ref={benefitsSceneRef}>
        <section className="landing-benefits" aria-labelledby="benefits-heading">
          <p>다모아로 하는 간편 정산</p>
          <h2 id="benefits-heading">필요한 건 함께한 시간뿐이에요</h2>
          <div className="landing-benefit-list">
            {benefits.map(({ title, description, Icon }) => (
              <article key={title}>
                <span><Icon size={21} /></span>
                <div><strong>{title}</strong><small>{description}</small></div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="landing-actions" aria-label="다모아 시작하기">
        <Link className="landing-signup" href="/login">카카오로 시작하기</Link>
        <p>이미 다모아를 사용 중인가요? <Link href="/login">로그인</Link></p>
      </section>
    </main>
  )
}
