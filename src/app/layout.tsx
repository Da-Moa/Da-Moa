import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '다모아 | 간편 정산',
  description: '영수증으로 시작하는 간편한 모임 정산',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
