'use client'

import { ChangeEvent, useMemo, useState } from 'react'
import {
  Bell,
  Camera,
  Check,
  ChevronRight,
  History,
  ImagePlus,
  Minus,
  Plus,
  ReceiptText,
  Users,
  WalletCards,
} from 'lucide-react'
import { splitAmounts } from '../lib/split'

const INITIAL_TOTAL = 58_300
const INITIAL_PEOPLE = 4
const won = new Intl.NumberFormat('ko-KR')

export default function Home() {
  const [receiptName, setReceiptName] = useState<string | null>(null)
  const [total, setTotal] = useState(INITIAL_TOTAL)
  const [people, setPeople] = useState(INITIAL_PEOPLE)
  const [settlementStarted, setSettlementStarted] = useState(false)
  const amounts = useMemo(() => splitAmounts(total, people), [total, people])

  function onReceiptSelect(event: ChangeEvent<HTMLInputElement>) {
    setReceiptName(event.target.files?.[0]?.name ?? null)
  }

  return (
    <main className="app-shell" id="home">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="다모아 홈">
          <img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" />
        </a>
        <button className="icon-button" type="button" aria-label="알림">
          <Bell size={21} strokeWidth={2.2} />
        </button>
      </header>

      <section className="welcome" aria-labelledby="welcome-heading">
        <p>정산이 필요할 때</p>
        <h1 id="welcome-heading">한 번에 깔끔하게<br />다모아 정산해요.</h1>
      </section>

      <section className="summary-card" aria-labelledby="summary-heading">
        <div className="summary-heading">
          <div>
            <p>진행 중인 정산</p>
            <h2 id="summary-heading">친구들과 점심</h2>
          </div>
          <span className="status-badge">3명 대기</span>
        </div>
        <div className="summary-amount">
          <span>내가 받을 금액</span>
          <strong>{won.format(amounts[0] ?? 0)}원</strong>
        </div>
        <a className="summary-link" href="#create">정산 이어서 하기 <ChevronRight size={18} /></a>
      </section>

      <section className="shortcuts" aria-labelledby="shortcut-heading">
        <h2 id="shortcut-heading">빠른 정산</h2>
        <div className="shortcut-grid">
          <a href="#create"><span><Plus size={22} /></span>새 정산</a>
          <a href="#create"><span><ImagePlus size={21} /></span>영수증 추가</a>
          <a href="#history"><span><History size={21} /></span>정산 내역</a>
        </div>
      </section>

      <section className="activity" id="history" aria-labelledby="activity-heading">
        <div className="section-title">
          <h2 id="activity-heading">최근 정산</h2>
          <a href="#history">전체 보기</a>
        </div>
        <article className="activity-item">
          <span className="activity-icon"><WalletCards size={21} /></span>
          <div>
            <strong>친구들과 점심</strong>
            <small>오늘 · 4명</small>
          </div>
          <b>58,300원</b>
        </article>
      </section>

      <section className="create-section" id="create" aria-labelledby="create-heading">
        <div className="section-title">
          <div>
            <p>새로운 정산</p>
            <h2 id="create-heading">영수증으로 시작하기</h2>
          </div>
        </div>

        <label className={`receipt-card${receiptName ? ' receipt-selected' : ''}`}>
          <input accept="image/*" capture="environment" onChange={onReceiptSelect} type="file" />
          <span className="receipt-icon">
            {receiptName ? <Check size={21} strokeWidth={3} /> : <Camera size={22} />}
          </span>
          <span className="receipt-content">
            <strong>{receiptName ?? '영수증 촬영하기'}</strong>
            <small>{receiptName ? '영수증을 불러왔어요' : '카메라 또는 사진 보관함에서 선택'}</small>
          </span>
          <ChevronRight aria-hidden="true" size={20} />
        </label>
        <p className="hint"><ReceiptText size={15} /> OCR 연동 전에는 금액을 직접 입력해요.</p>

        <div className="split-card">
          <label className="amount-label" htmlFor="total">총 결제 금액</label>
          <div className="amount-field">
            <input
              id="total"
              inputMode="numeric"
              min="0"
              onChange={(event) => setTotal(Math.max(0, Number(event.target.value) || 0))}
              type="number"
              value={total}
            />
            <span>원</span>
          </div>
          <div className="divider" />
          <div className="people-row">
            <span><Users size={18} /> 함께한 사람</span>
            <div className="stepper" aria-label="인원 수">
              <button aria-label="인원 한 명 줄이기" disabled={people === 1} onClick={() => setPeople((current) => current - 1)} type="button"><Minus size={16} /></button>
              <strong>{people}명</strong>
              <button aria-label="인원 한 명 늘리기" onClick={() => setPeople((current) => current + 1)} type="button"><Plus size={16} /></button>
            </div>
          </div>
        </div>

        <div className="result-card">
          <p>1인당 낼 금액</p>
          <strong>{won.format(amounts[0] ?? 0)}<small>원</small></strong>
          <span>{people}명이 똑같이 나눠 내요</span>
        </div>

        <button className="settle-button" onClick={() => setSettlementStarted(true)} type="button">
          정산 링크 만들기 <ChevronRight size={20} />
        </button>
        <p className="status" aria-live="polite">{settlementStarted ? '다음 단계에서 참여자와 송금 수단을 연결합니다.' : ''}</p>
      </section>

      <nav className="bottom-nav" aria-label="주요 메뉴">
        <a aria-current="page" href="#home"><WalletCards size={20} />홈</a>
        <a href="#create"><ReceiptText size={20} />정산</a>
        <a href="#history"><History size={20} />내역</a>
        <a href="#create"><Users size={20} />모임</a>
      </nav>
    </main>
  )
}
