import { ArrowLeft, Check, MessageCircle } from 'lucide-react'
import Link from 'next/link'
import { getLoginMessage } from '../../lib/login-message'
import { safeReturnTo } from '../../lib/auth'
import { TEST_ACCOUNTS } from '../../lib/test-accounts'

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ error?: string; returnTo?: string }> }>) {
  const { error, returnTo } = await searchParams
  const message = getLoginMessage(error)

  return (
    <main className="auth-page">
      <Link className="auth-back" href="/" aria-label="홈으로 돌아가기">
        <ArrowLeft size={22} />
      </Link>

      <section className="auth-content" aria-labelledby="auth-heading">
        <div className="auth-logo" aria-hidden="true">
          <img alt="" height="72" src="/logo/da-moa-trans.png" width="87" />
        </div>
        <p className="auth-eyebrow">모임 정산을 더 간편하게</p>
        <h1 id="auth-heading">다모아와 함께<br />정산을 시작해요</h1>
        <p className="auth-description">카카오 계정으로 로그인하면 내 정산 내역과<br />친구들과의 모임을 안전하게 관리할 수 있어요</p>

        <div className="auth-benefits" aria-label="로그인 후 이용할 수 있는 기능">
          <span><Check size={15} /> 정산 내역 저장</span>
          <span><Check size={15} /> 모임 멤버 관리</span>
        </div>
      </section>

      <section className="auth-actions" aria-label="로그인 수단">
        <a className="kakao-login" href={`/api/auth/kakao?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`}>
          <MessageCircle aria-hidden="true" fill="currentColor" size={20} />
          카카오로 시작하기
        </a>
        {process.env.NODE_ENV !== 'production' && <div className="test-account-list stack">
          <p className="help-text">개발 테스트 계정</p>
          {TEST_ACCOUNTS.map(account => <form action="/api/auth/test-login" method="post" key={account.key}>
            <input name="key" type="hidden" value={account.key} />
            <input name="returnTo" type="hidden" value={safeReturnTo(returnTo)} />
            <button className="secondary-button" type="submit">{account.displayName}로 로그인</button>
          </form>)}
        </div>}
        {message && <p className="auth-setup" role="alert">{message}</p>}
      </section>
    </main>
  )
}
