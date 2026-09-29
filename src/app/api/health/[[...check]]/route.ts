import { healthResponse } from '../../../../lib/health'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ check?: string[] }> }) {
  const { check } = await params
  if (!check?.length) return healthResponse('overall')
  if (check.length === 1 && check[0] === 'live') return healthResponse('live')
  if (check.length === 1 && check[0] === 'dependencies') return healthResponse('dependencies')
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
}
