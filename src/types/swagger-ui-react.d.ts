declare module 'swagger-ui-react' {
  import type { ComponentType } from 'react'

  const SwaggerUI: ComponentType<{
    docExpansion?: string
    supportedSubmitMethods?: string[]
    url: string
  }>

  export default SwaggerUI
}

declare module 'swagger-ui-react/swagger-ui.css'
