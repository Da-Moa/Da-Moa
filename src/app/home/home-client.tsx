'use client'

import { ChangeEvent, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Bell,
  Camera,
  Check,
  ChevronRight,
  CircleUserRound,
  History,
  ImagePlus,
  Menu,
  Minus,
  Plus,
  ReceiptText,
  Users,
  WalletCards,
  X,
} from 'lucide-react'
import { splitAmounts } from '../../lib/split'

const INITIAL_TOTAL = 58_300
const INITIAL_PEOPLE = 4
const won = new Intl.NumberFormat('ko-KR')

type UserAccount = {
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
} | null

type HomeTab = 'home' | 'groups' | 'history' | 'all'

export default function HomeClient({ account, tab }: { account: UserAccount; tab: HomeTab }) {
  const accountDialog = useRef<HTMLDialogElement>(null)
  const [receiptName, setReceiptName] = useState<string | null>(null)
  const [total, setTotal] = useState(INITIAL_TOTAL)
  const [people, setPeople] = useState(INITIAL_PEOPLE)
  const [settlementStarted, setSettlementStarted] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawalError, setWithdrawalError] = useState<string | null>(null)
  const amounts = useMemo(() => splitAmounts(total, people), [total, people])

  function onReceiptSelect(event: ChangeEvent<HTMLInputElement>) {
    setReceiptName(event.target.files?.[0]?.name ?? null)
  }

  function openAccountDialog() {
    accountDialog.current?.showModal()
  }

  async function logout() {
    setLoggingOut(true)
    setLogoutError(null)

    try {
      const response = await fetch('/api/auth/logout', {
        cache: 'no-store',
        credentials: 'same-origin',
        method: 'POST',
      })
      if (!response.ok) throw new Error('Logout failed')
      window.location.replace('/login')
    } catch {
      setLoggingOut(false)
      setLogoutError('로그아웃에 실패했어요. 다시 시도해 주세요')
    }
  }

  async function withdraw() {
    if (!window.confirm('다모아에 저장된 계정 정보와 모든 로그인 세션이 삭제되며 되돌릴 수 없어요. 카카오 계정 자체는 삭제되지 않아요. 탈퇴할까요?')) {
      return
    }

    setWithdrawing(true)
    setLogoutError(null)
    setWithdrawalError(null)

    try {
      const response = await fetch('/api/auth/withdraw', {
        cache: 'no-store',
        credentials: 'same-origin',
        method: 'POST',
      })
      if (response.status === 401) {
        window.location.replace('/')
        return
      }
      if (!response.ok) throw new Error('Withdrawal failed')
      window.location.replace('/')
    } catch {
      setWithdrawing(false)
      setWithdrawalError('회원 탈퇴에 실패했어요. 다시 시도해 주세요')
    }
  }

  return (
    <main className="app-shell" id="home">
      <header className="topbar">
        <Link className="brand" href="/home" aria-label="다모아 홈">
          <img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" />
        </Link>
        <div className="topbar-actions">
          <button
            aria-controls="account-dialog"
            aria-haspopup="dialog"
            aria-label="마이페이지"
            className="icon-button"
            onClick={openAccountDialog}
            type="button"
          >
            <CircleUserRound size={21} strokeWidth={2.2} />
          </button>
          <button className="icon-button" type="button" aria-label="알림">
            <Bell size={21} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      <dialog
        aria-labelledby="account-dialog-title"
        className="account-dialog"
        id="account-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
        ref={accountDialog}
      >
        <div className="account-dialog-content">
          <div className="account-dialog-header">
            <div>
              <p>내 계정</p>
              <h2 id="account-dialog-title">마이페이지</h2>
            </div>
            <form method="dialog">
              <button className="icon-button account-dialog-close" type="submit" aria-label="계정 정보 닫기">
                <X size={19} strokeWidth={2.5} />
              </button>
            </form>
          </div>
          <div className="account-provider">
            <span className="account-avatar">
              {account?.profileImageUrl
                ? <img alt="" height="56" referrerPolicy="no-referrer" src={account.profileImageUrl} width="56" />
                : <CircleUserRound size={28} />}
            </span>
            <div>
              <strong>{account?.displayName ?? '카카오 사용자'}</strong>
            </div>
          </div>
          <dl className="account-details">
            <div>
              <dt>닉네임</dt>
              <dd>{account?.displayName ?? '카카오에서 제공되지 않았어요'}</dd>
            </div>
            <div>
              <dt>이메일</dt>
              <dd>{account?.email ?? '카카오에서 제공되지 않았어요'}</dd>
            </div>
          </dl>
          <button className="account-logout-button" disabled={loggingOut || withdrawing} onClick={() => void logout()} type="button">
            {loggingOut ? '로그아웃 중...' : '로그아웃'}
          </button>
          {logoutError && <p className="account-logout-error" role="alert">{logoutError}</p>}
          <button className="account-withdraw-button" disabled={loggingOut || withdrawing} onClick={() => void withdraw()} type="button">
            {withdrawing ? '탈퇴 처리 중...' : '회원 탈퇴'}
          </button>
          {withdrawalError && <p className="account-withdraw-error" role="alert">{withdrawalError}</p>}
        </div>
      </dialog>

      {tab === 'home' && <>
        <section className="welcome" aria-labelledby="welcome-heading">
          <p>정산이 필요할 때</p>
          <h1 id="welcome-heading">한 번에 깔끔하게<br />다모아 정산해요</h1>
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
          <Link className="summary-link" href="/home/groups">정산 이어서 하기 <ChevronRight size={18} /></Link>
        </section>

        <section className="shortcuts" aria-labelledby="shortcut-heading">
          <h2 id="shortcut-heading">빠른 정산</h2>
          <div className="shortcut-grid">
            <Link href="/home/groups"><span><Plus size={22} /></span>새 정산</Link>
            <Link href="/home/groups#receipt"><span><ImagePlus size={21} /></span>영수증 추가</Link>
            <Link href="/home/history"><span><History size={21} /></span>정산 내역</Link>
          </div>
        </section>
      </>}

      {tab === 'groups' && <>
        <section className="tab-heading" aria-labelledby="groups-heading">
          <p>함께하는 정산</p>
          <h1 id="groups-heading">모임 정산 만들기</h1>
        </section>

        <section className="create-section tab-create" id="groups" aria-labelledby="create-heading">
          <div className="section-title">
            <div>
              <p>새로운 정산</p>
              <h2 id="create-heading">영수증으로 시작하기</h2>
            </div>
          </div>

          <label className={`receipt-card${receiptName ? ' receipt-selected' : ''}`} id="receipt">
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
          <p className="hint"><ReceiptText size={15} /> OCR 연동 전에는 금액을 직접 입력해요</p>

          <div className="split-card" id="calculator">
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
          <p className="status" aria-live="polite">{settlementStarted ? '다음 단계에서 참여자와 송금 수단을 연결합니다' : ''}</p>
        </section>
      </>}

      {tab === 'history' && <>
        <section className="tab-heading" aria-labelledby="history-heading">
          <p>지난 모임 기록</p>
          <h1 id="history-heading">정산 내역</h1>
        </section>

        <section className="activity history-list" aria-labelledby="recent-history-heading">
          <div className="section-title">
            <h2 id="recent-history-heading">최근 정산</h2>
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
      </>}

      {tab === 'all' && <>
        <section className="tab-heading" aria-labelledby="all-heading">
          <p>전체 기능</p>
          <h1 id="all-heading">다모아를<br />한눈에 확인해요</h1>
        </section>

        <section className="all-functions" aria-label="다모아 기능 목록">
          <Link className="all-function-row" href="/home/groups">
            <span className="all-function-icon"><Plus size={21} /></span>
            <span className="all-function-copy"><strong>새 정산</strong><small>모임 정산을 새로 만들어요</small></span>
            <ChevronRight size={19} />
          </Link>
          <Link className="all-function-row" href="/home/groups#receipt">
            <span className="all-function-icon"><ImagePlus size={21} /></span>
            <span className="all-function-copy"><strong>영수증 추가</strong><small>사진을 선택해 정산을 시작해요</small></span>
            <ChevronRight size={19} />
          </Link>
          <Link className="all-function-row" href="/home/groups#calculator">
            <span className="all-function-icon"><Users size={21} /></span>
            <span className="all-function-copy"><strong>1/N 금액 계산</strong><small>함께한 인원만큼 나눠 계산해요</small></span>
            <ChevronRight size={19} />
          </Link>
          <Link className="all-function-row" href="/home/history">
            <span className="all-function-icon"><History size={21} /></span>
            <span className="all-function-copy"><strong>정산 내역</strong><small>최근 모임 정산을 확인해요</small></span>
            <ChevronRight size={19} />
          </Link>
          <button className="all-function-row" onClick={openAccountDialog} type="button">
            <span className="all-function-icon"><CircleUserRound size={21} /></span>
            <span className="all-function-copy"><strong>마이페이지</strong><small>계정 정보와 로그아웃, 탈퇴를 관리해요</small></span>
            <ChevronRight size={19} />
          </button>
          <button className="all-function-row all-logout-row" disabled={loggingOut || withdrawing} onClick={() => void logout()} type="button">
            <span className="all-function-icon"><X size={21} /></span>
            <span className="all-function-copy"><strong>{loggingOut ? '로그아웃 중...' : '로그아웃'}</strong><small>이 기기의 다모아 세션을 종료해요</small></span>
            <ChevronRight size={19} />
          </button>
          {logoutError && <p className="account-logout-error" role="alert">{logoutError}</p>}
        </section>
      </>}

      <nav className="bottom-nav" aria-label="주요 메뉴">
        <Link aria-current={tab === 'home' ? 'page' : undefined} href="/home"><WalletCards size={20} />홈</Link>
        <Link aria-current={tab === 'groups' ? 'page' : undefined} href="/home/groups"><Users size={20} />모임</Link>
        <Link aria-current={tab === 'history' ? 'page' : undefined} href="/home/history"><History size={20} />내역</Link>
        <Link aria-current={tab === 'all' ? 'page' : undefined} href="/home/all"><Menu size={20} />전체</Link>
      </nav>
    </main>
  )
}
