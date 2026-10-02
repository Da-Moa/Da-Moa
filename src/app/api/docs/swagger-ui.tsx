'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { apiRequest } from '../../../lib/api-client'
import { ErrorNotice, Loading } from '../../home/ui'
import 'swagger-ui-react/swagger-ui.css'

const SwaggerUI = dynamic(
  () => import('swagger-ui-react').then((module) => module.default),
  { ssr: false },
)

export default function SwaggerUi() {
  const [spec, setSpec] = useState<object>()
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => { void apiRequest<object>('/api/openapi.json').then(setSpec).catch(setError) }, [])
  if (error) return <ErrorNotice error={error} />
  if (!spec) return <Loading />
  return (
    <SwaggerUI
      docExpansion="list"
      supportedSubmitMethods={[]}
      spec={spec}
    />
  )
}
