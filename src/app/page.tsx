'use client'

import { useEffect, useRef } from 'react'
import { ArrowRight, ReceiptText, Users, WalletCards } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import hero from '../assets/hero.png'
import { heroPhase } from '../lib/hero-phase'

const benefits = [
  { title: '영수증 한 장으로', description: '총 금액을 빠르게 입력해요.', Icon: ReceiptText },
  { title: '정확하게 1/N', description: '인원수만 정하면 끝이에요.', Icon: Users },
  { title: '링크 하나로', description: '친구들에게 정산을 요청해요.', Icon: WalletCards },
]

export default function LandingPage() {
  const heroSceneRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const scene = heroSceneRef.current
    if (!scene) return

    let animationFrame = 0
    const updatePhase = () => {
      animationFrame = 0
      scene.dataset.phase = String(heroPhase(Math.max(0, -scene.getBoundingClientRect().top)))
    }
    const onScroll = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(updatePhase)
    }

    document.documentElement.classList.add('hero-sequence-ready')
    updatePhase()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)

    return () => {
      cancelAnimationFrame(animationFrame)
      document.documentElement.classList.remove('hero-sequence-ready')
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
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

      <section className="landing-hero-scene" aria-labelledby="landing-heading" data-phase="0" ref={heroSceneRef}>
        <div className="landing-hero">
          <div className="landing-hero-copy">
            <p>더치페이, 이제 가볍게</p>
            <h1 id="landing-heading">모임비 정산,<br />다모아로 끝내요.</h1>
            <span>영수증부터 송금 요청까지<br />복잡한 정산을 한 곳에서.</span>
          </div>
          <Image alt="정산 과정을 상징하는 카드 일러스트" className="landing-hero-image" priority src={hero} />
          <div className="landing-amount-card" aria-hidden="true">
            <small>1인당 낼 금액</small>
            <strong>14,575<span>원</span></strong>
            <em>4명이 함께해요</em>
          </div>
        </div>
      </section>

      <section className="landing-benefits" aria-labelledby="benefits-heading">
        <p>다모아로 하는 간편 정산</p>
        <h2 id="benefits-heading">필요한 건 함께한 시간뿐이에요.</h2>
        <div className="landing-benefit-list">
          {benefits.map(({ title, description, Icon }) => (
            <article key={title}>
              <span><Icon size={21} /></span>
              <div><strong>{title}</strong><small>{description}</small></div>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-actions" aria-label="다모아 시작하기">
        <Link className="landing-signup" href="/login">
          카카오로 무료 시작하기 <ArrowRight size={19} />
        </Link>
        <p>이미 다모아를 사용 중인가요? <Link href="/login">로그인</Link></p>
      </section>
    </main>
  )
}
