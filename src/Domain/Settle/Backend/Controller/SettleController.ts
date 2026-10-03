import 'server-only'
import { after, NextRequest } from 'next/server'
import { readRequestAccessToken } from '../../../../Global/Auth/Backend'
import { AppError, errorResponse } from '../../../../Global/Util/Backend'
import { readJsonBody as jsonBody, sameOrigin } from '../../../../Global/Util/Backend'
import { publishRoundInvalidation, realtimeEnabled, type RoundAudience } from '../../../../Global/Websocket/Backend'
import { addReceipt, checkExclusion, createRound, deleteExpense, excludeMember, getReceipt, getRound, getSettlement, listRounds, removeReceipt, roundCommand, saveExpense, setSettlementCheck } from '../Service/SettleService'

export function isSettlePath(path: string[]) {
  return path[0] === 'rounds' || path[0] === 'receipts' || (path[0] === 'groups' && path[2] === 'rounds')
}

export async function getSettleResponse(request: NextRequest, path: string[]): Promise<Response> {
  try {
    const method = request.method
    const access = readRequestAccessToken(request)
    if (method !== 'GET' && !sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const key = request.headers.get('idempotency-key') ?? ''
    const query = request.nextUrl.searchParams
    let data: unknown
    let affectedAudience: RoundAudience | null | undefined
    if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'GET') data = await listRounds(access, query, path[1])
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'POST') data = await createRound(access, key, path[1], await jsonBody(request), userIds => { affectedAudience = { groupId: path[1], userIds } })
    else if (path[0] === 'rounds' && path.length === 1 && method === 'GET') data = await listRounds(access, query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'GET') data = await getRound(access, path[1], query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'DELETE') {
      affectedAudience = null
      data = await roundCommand(access, key, path[1], 'cancel', await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'settlement' && method === 'GET') data = await getSettlement(access, path[1])
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'settlement-check' && method === 'POST') data = await setSettlementCheck(access, key, path[1], await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'expenses' && method === 'POST') {
      affectedAudience = null
      data = await saveExpense(access, key, path[1], await jsonBody(request), undefined, audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 3 && ['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].includes(path[2]) && method === 'POST') {
      if (['confirm', 'reopen', 'draw'].includes(path[2])) affectedAudience = null
      data = await roundCommand(access, key, path[1], path[2], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'PATCH') {
      affectedAudience = null
      data = await saveExpense(access, key, path[1], await jsonBody(request), path[3], audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'DELETE') {
      affectedAudience = null
      data = await deleteExpense(access, key, path[1], path[3], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclusion-check' && method === 'GET') data = await checkExclusion(access, path[1], path[3])
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclude' && method === 'POST') {
      affectedAudience = null
      data = await excludeMember(access, key, path[1], path[3], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'POST') {
      if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
      let form: FormData
      try { form = await request.formData() } catch { throw new AppError(400, 'invalid_input', '영수증 업로드 형식을 확인해 주세요') }
      const file = form.get('file')
      if (!(file instanceof File) || form.getAll('file').length !== 1 || [...form.keys()].some(k => !['file', 'expectedVersion'].includes(k))) throw new AppError(400, 'invalid_input', '이미지를 한 개씩 올려 주세요')
      data = await addReceipt(access, key, path[1], path[3], Number(form.get('expectedVersion')), new Uint8Array(await file.arrayBuffer()), file.type)
    } else if (path[0] === 'rounds' && path.length === 6 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'DELETE') data = await removeReceipt(access, key, path[1], path[3], path[5], await jsonBody(request))
    else if (path[0] === 'receipts' && path.length === 2 && method === 'GET') {
      const receipt = await getReceipt(access, path[1])
      return new Response(new Uint8Array(receipt.content).buffer, { headers: { 'Content-Type': receipt.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } })
    } else throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
    if (method !== 'GET' && realtimeEnabled()) {
      if (path[0] === 'groups' && path[2] === 'rounds') after(() => publishRoundInvalidation((data as { roundId?: string; id: string }).roundId ?? (data as { id: string }).id, false, affectedAudience))
      else if (path[0] === 'rounds') after(() => publishRoundInvalidation(path[1], path[2] === 'members', affectedAudience))
    }
    return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return errorResponse(error) }
}
