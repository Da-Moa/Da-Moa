'use client'

import dynamic from 'next/dynamic'
import 'swagger-ui-react/swagger-ui.css'

const SwaggerUI = dynamic(
  () => import('swagger-ui-react').then((module) => module.default),
  { ssr: false },
)

export default function SwaggerUi() {
  return (
    <SwaggerUI
      docExpansion="list"
      supportedSubmitMethods={[]}
      url="/api/openapi.json"
    />
  )
}
