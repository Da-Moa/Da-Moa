import type { Metadata } from 'next'
import { connection } from 'next/server'
import { getKakaoRedirectUris } from '../Global/Auth/Backend'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  // Docker builds run before the public origin is configured at runtime.
  await connection()

  return {
    metadataBase: new URL(new URL(getKakaoRedirectUris()[0] ?? 'http://localhost:3000').origin),
    title: '다모아 | 간편 정산',
    description: '영수증으로 시작하는 간편한 모임 정산',
    icons: { icon: { url: '/logo/da-moa-128px-trans.png', type: 'image/png', sizes: '128x128' } },
    openGraph: {
      title: '다모아 | 간편 정산',
      description: '영수증으로 시작하는 간편한 모임 정산',
      siteName: '다모아',
      locale: 'ko_KR',
      type: 'website',
      images: [{ url: '/og/da-moa-og.png', width: 2848, height: 1504, alt: '다모아 | 간편 정산' }],
    },
  }
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
