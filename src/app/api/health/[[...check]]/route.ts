import { getHealthResponse } from '../../../../Domain/Health/Backend'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ check?: string[] }> }) {
  const { check } = await params
  return getHealthResponse(check)
}
