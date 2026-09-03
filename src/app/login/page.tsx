import { ArrowLeft, Check, MessageCircle, ShieldCheck } from 'lucide-react'
import Link from 'next/link'

const kakaoClientId = process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY
const kakaoRedirectUri = process.env.NEXT_PUBLIC_KAKAO_REDIRECT_URI
const kakaoLoginUrl = kakaoClientId && kakaoRedirectUri
  ? `https://kauth.kakao.com/oauth/authorize?${new URLSearchParams({
      client_id: kakaoClientId,
      redirect_uri: kakaoRedirectUri,
      response_type: 'code',
    })}`
  : null

export default function LoginPage() {
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
        <h1 id="auth-heading">다모아와 함께<br />정산을 시작해요.</h1>
        <p className="auth-description">카카오 계정으로 로그인하면 내 정산 내역과<br />친구들과의 모임을 안전하게 관리할 수 있어요.</p>

        <div className="auth-benefits" aria-label="로그인 후 이용할 수 있는 기능">
          <span><Check size={15} /> 정산 내역 저장</span>
          <span><Check size={15} /> 모임 멤버 관리</span>
        </div>
      </section>

      <section className="auth-actions" aria-label="로그인 수단">
        {kakaoLoginUrl ? (
          <a className="kakao-login" href={kakaoLoginUrl}>
            <MessageCircle aria-hidden="true" fill="currentColor" size={20} />
            카카오로 시작하기
          </a>
        ) : (
          <button className="kakao-login" disabled type="button">
            <MessageCircle aria-hidden="true" fill="currentColor" size={20} />
            카카오로 시작하기
          </button>
        )}
        <p className="auth-notice"><ShieldCheck size={15} /> 카카오 로그인으로 필요한 정보만 안전하게 받아요.</p>
        {!kakaoLoginUrl && <p className="auth-setup">카카오 앱 키와 Redirect URI를 설정하면 로그인을 시작할 수 있어요.</p>}
      </section>
    </main>
  )
}
