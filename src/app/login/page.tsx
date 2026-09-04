import { ArrowLeft, Check, MessageCircle } from 'lucide-react'
import Link from 'next/link'

const loginMessages: Record<string, string> = {
  configuration: '로그인 설정을 확인해 주세요',
  failed: '로그인을 완료하지 못했어요. 다시 시도해 주세요',
  invalid: '로그인 요청이 만료되었어요. 다시 시도해 주세요',
}

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ error?: string }> }>) {
  const { error } = await searchParams
  const message = error ? loginMessages[error] ?? loginMessages.failed : undefined

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
        <a className="kakao-login" href="/api/auth/kakao">
          <MessageCircle aria-hidden="true" fill="currentColor" size={20} />
          카카오로 시작하기
        </a>
        {message && <p className="auth-setup" role="alert">{message}</p>}
      </section>
    </main>
  )
}
