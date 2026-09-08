import { after, NextRequest } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../lib/auth'
import { AppError, errorResponse } from '../../../lib/errors'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, leaveGroup, listGroups, revokeInvite } from '../../../lib/group-store'
import { readBytes, readJsonBody as jsonBody } from '../../../lib/http'
import { captureGroupAudience, captureRoundAudience, createRealtimeToken, publishGroupInvalidation, publishRoundInvalidation, realtimeEnabled, type RoundAudience } from '../../../lib/realtime-server'
import { addReceipt, checkExclusion, createRound, deleteExpense, excludeMember, getReceipt, getRound, getSettlement, listRounds, removeReceipt, roundCommand, saveExpense } from '../../../lib/round-store'

export const runtime = 'nodejs'

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const method = request.method, { path } = await context.params
    const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
    if (path[0] === 'realtime' && path[1] === 'auth' && path.length === 2 && method === 'GET') {
      const origin = request.headers.get('origin')
      if (origin && origin !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
      return Response.json({ data: await createRealtimeToken(access) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
    }
    if (method !== 'GET' && request.headers.get('origin') !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const key = request.headers.get('idempotency-key') ?? ''
    const query = request.nextUrl.searchParams
    let data: unknown
    let cancelledAudience: RoundAudience | null | undefined
    let departingGroupAudience: string[] | undefined
    if (path[0] === 'rounds' && path.length === 2 && method === 'DELETE') cancelledAudience = await captureRoundAudience(access, path[1])
    if (path[0] === 'groups' && path.length === 2 && method === 'DELETE') departingGroupAudience = await captureGroupAudience(access, path[1])
    if (path[0] === 'groups' && path.length === 1 && method === 'GET') data = await listGroups(access, query)
    else if (path[0] === 'groups' && path.length === 1 && method === 'POST') data = await createGroup(access, key, await jsonBody(request))
    else if (path[0] === 'groups' && path.length === 2 && method === 'GET') data = await getGroup(access, path[1])
    else if (path[0] === 'groups' && path.length === 2 && method === 'DELETE') data = await leaveGroup(access, key, path[1])
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'GET') data = await listRounds(access, query, path[1])
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'rounds' && method === 'POST') data = await createRound(access, key, path[1], await jsonBody(request))
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'invites' && method === 'POST') data = await createInvite(access, key, path[1], await jsonBody(request))
    else if (path[0] === 'groups' && path.length === 4 && path[2] === 'invites' && method === 'DELETE') data = await revokeInvite(access, key, path[1], path[3])
    else if (path[0] === 'invites' && path.length === 2 && method === 'GET') data = await getInvite(access, path[1])
    else if (path[0] === 'invites' && path.length === 3 && path[2] === 'accept' && method === 'POST') data = await acceptInvite(access, key, path[1])
    else if (path[0] === 'rounds' && path.length === 1 && method === 'GET') data = await listRounds(access, query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'GET') data = await getRound(access, path[1], query)
    else if (path[0] === 'rounds' && path.length === 2 && method === 'DELETE') data = await roundCommand(access, key, path[1], 'cancel', await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'settlement' && method === 'GET') data = await getSettlement(access, path[1])
    else if (path[0] === 'rounds' && path.length === 3 && path[2] === 'expenses' && method === 'POST') data = await saveExpense(access, key, path[1], await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 3 && ['confirm', 'reopen', 'send', 'draw', 'complete'].includes(path[2]) && method === 'POST') data = await roundCommand(access, key, path[1], path[2], await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'PATCH') data = await saveExpense(access, key, path[1], await jsonBody(request), path[3])
    else if (path[0] === 'rounds' && path.length === 4 && path[2] === 'expenses' && method === 'DELETE') data = await deleteExpense(access, key, path[1], path[3], await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclusion-check' && method === 'GET') data = await checkExclusion(access, path[1], path[3])
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'members' && path[4] === 'exclude' && method === 'POST') data = await excludeMember(access, key, path[1], path[3], await jsonBody(request))
    else if (path[0] === 'rounds' && path.length === 5 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'POST') {
      const bytes = await readBytes(request, 2097152 + 65536, 'receipt_too_large')
      let form: FormData
      try { form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData() } catch { throw new AppError(400, 'invalid_input', '영수증 업로드 형식을 확인해 주세요') }
      const file = form.get('file')
      if (!(file instanceof File) || form.getAll('file').length !== 1 || [...form.keys()].some(k => !['file', 'expectedVersion'].includes(k))) throw new AppError(400, 'invalid_input', '이미지를 한 개씩 올려 주세요')
      data = await addReceipt(access, key, path[1], path[3], Number(form.get('expectedVersion')), new Uint8Array(await file.arrayBuffer()), file.type)
    } else if (path[0] === 'rounds' && path.length === 6 && path[2] === 'expenses' && path[4] === 'receipts' && method === 'DELETE') data = await removeReceipt(access, key, path[1], path[3], path[5], await jsonBody(request))
    else if (path[0] === 'receipts' && path.length === 2 && method === 'GET') {
      const receipt = await getReceipt(access, path[1])
      return new Response(receipt.content, { headers: { 'Content-Type': receipt.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } })
    } else throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
    if (method !== 'GET' && realtimeEnabled()) {
      if (path[0] === 'groups' && path.length === 1) after(() => publishGroupInvalidation((data as { id: string }).id))
      else if (path[0] === 'groups' && path[2] === 'rounds') after(() => publishRoundInvalidation((data as { roundId?: string; id: string }).roundId ?? (data as { id: string }).id))
      else if (path[0] === 'groups') after(() => publishGroupInvalidation(path[1], departingGroupAudience))
      else if (path[0] === 'invites' && path[2] === 'accept') after(() => publishGroupInvalidation((data as { id: string }).id))
      else if (path[0] === 'rounds') after(() => publishRoundInvalidation(path[1], path[2] === 'members', cancelledAudience))
    }
    return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return errorResponse(error) }
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE }
