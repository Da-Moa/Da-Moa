import 'server-only'
import { after, NextRequest } from 'next/server'
import { readRequestAccessToken } from '../../../../Global/Auth/Backend'
import { AppError, errorResponse } from '../../../../Global/Util/Backend'
import { readBytes, readJsonBody as jsonBody, sameOrigin } from '../../../../Global/Util/Backend'
import { MAX_RECEIPT_REQUEST_BYTES } from '../../Shared'
import { realtimeEnabled } from '../../../../Global/Websocket/Backend'
import { publishRoundInvalidation, type RoundAudience } from './SettleInvalidation'
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
    let affectedAudience: RoundAudience | null = null
    if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'GET') data = await listRounds(access, query, path[1])
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'POST') data = await createRound(access, key, path[1], await jsonBody(request), userIds => { affectedAudience = { groupId: path[1], userIds } })
    else if (path[0] === 'rounds' && path.length === 1 && method === 'GET') data = await listRounds(access, query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'GET') data = await getRound(access, path[1], query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'DELETE') {
      data = await roundCommand(access, key, path[1], 'cancel', await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'settlement' && method === 'GET') data = await getSettlement(access, path[1])
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'settlement-check' && method === 'POST') {
      data = await setSettlementCheck(access, key, path[1], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'expenses' && method === 'POST') {
      data = await saveExpense(access, key, path[1], await jsonBody(request), undefined, audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 3 && ['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].includes(path[2]) && method === 'POST') {
      data = await roundCommand(access, key, path[1], path[2], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'PATCH') {
      data = await saveExpense(access, key, path[1], await jsonBody(request), path[3], audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'DELETE') {
      data = await deleteExpense(access, key, path[1], path[3], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclusion-check' && method === 'GET') data = await checkExclusion(access, path[1], path[3])
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclude' && method === 'POST') {
      data = await excludeMember(access, key, path[1], path[3], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'POST') {
      data = await addReceipt(access, key, path[1], path[3], async () => {
        let form: FormData
        const bytes = await readBytes(request, MAX_RECEIPT_REQUEST_BYTES, 'receipt_too_large')
        try { form = await new Response(bytes.buffer, { headers: request.headers }).formData() } catch { throw new AppError(400, 'invalid_input', '영수증 업로드 형식을 확인해 주세요') }
        const file = form.get('file')
        if (!(file instanceof File) || form.getAll('file').length !== 1 || form.getAll('expectedVersion').length !== 1 || [...form.keys()].some(k => !['file', 'expectedVersion'].includes(k))) throw new AppError(400, 'invalid_input', '이미지를 한 개씩 올려 주세요')
        return { expectedVersion: Number(form.get('expectedVersion')), bytes: new Uint8Array(await file.arrayBuffer()), type: file.type, name: file.name }
      }, audience => { affectedAudience = audience })
    } else if (path[0] === 'rounds' && path.length === 6 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'DELETE') {
      data = await removeReceipt(access, key, path[1], path[3], path[5], await jsonBody(request), audience => { affectedAudience = audience })
    }
    else if (path[0] === 'receipts' && path.length === 2 && method === 'GET') {
      const receipt = await getReceipt(access, path[1])
      return new Response(new Uint8Array(receipt.content).buffer, { headers: { 'Content-Type': receipt.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } })
    } else throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
    if (method !== 'GET' && realtimeEnabled()) {
      if (path[0] === 'groups' && path[2] === 'rounds') after(() => publishRoundInvalidation((data as { roundId?: string; id: string }).roundId ?? (data as { id: string }).id, affectedAudience))
      else if (path[0] === 'rounds') after(() => publishRoundInvalidation(path[1], affectedAudience, path[2] === 'settlement-check'))
    }
    return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return errorResponse(error) }
}
