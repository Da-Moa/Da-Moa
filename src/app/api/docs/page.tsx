import type { Metadata } from 'next'
import SwaggerUi from './swagger-ui'

export const metadata: Metadata = {
  title: 'API 문서 | 다모아',
  description: '다모아 API 문서',
}

export default function ApiDocsPage() {
  return (
    <main>
      <SwaggerUi />
    </main>
  )
}
