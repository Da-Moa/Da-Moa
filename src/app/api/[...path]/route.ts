import type { NextRequest } from 'next/server'
import { AppError, errorResponse } from '../../../Global/Util/Backend'
import { getGroupResponse, isGroupPath } from '../../../Domain/Group/Backend'
import { getSettleResponse, isSettlePath } from '../../../Domain/Settle/Backend'

export const runtime = 'nodejs'

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params
    if (isGroupPath(path)) return getGroupResponse(request, path)
    if (isSettlePath(path)) return getSettleResponse(request, path)
    throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
  } catch (error) { return errorResponse(error) }
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE }
