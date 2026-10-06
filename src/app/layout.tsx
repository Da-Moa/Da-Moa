import type { Metadata } from 'next'
import { connection } from 'next/server'
import localFont from 'next/font/local'
import { getKakaoRedirectUris } from '../Global/Auth/Backend'
import './globals.css'

const presentationUI = localFont({
  src: [
    { path: '../assets/fonts/presentation-ui-100.woff2', weight: '100' },
    { path: '../assets/fonts/presentation-ui-200.woff2', weight: '200' },
    { path: '../assets/fonts/presentation-ui-300.woff2', weight: '300' },
    { path: '../assets/fonts/presentation-ui-400.woff2', weight: '400' },
    { path: '../assets/fonts/presentation-ui-500.woff2', weight: '500' },
    { path: '../assets/fonts/presentation-ui-600.woff2', weight: '600' },
    { path: '../assets/fonts/presentation-ui-700.woff2', weight: '700' },
    { path: '../assets/fonts/presentation-ui-800.woff2', weight: '800' },
    { path: '../assets/fonts/presentation-ui-900.woff2', weight: '900' },
  ],
  variable: '--font-presentation-ui',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: [],
})

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
    <html className={presentationUI.variable} lang="ko">
      <body>{children}</body>
    </html>
  )
}
