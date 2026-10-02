import 'server-only'
import { after, type NextRequest } from 'next/server'
import { readRequestAccessToken } from '../../../../Global/Auth/Backend'
import { AppError, errorResponse, readJsonBody, sameOrigin } from '../../../../Global/Util/Backend'
import { publishGroupInvalidation, realtimeEnabled } from '../../../../Global/Websocket/Backend'
import type { GroupMutationResult } from '../../Shared'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, leaveGroup, listGroups, revokeInvite } from '../Service/GroupService'

export function isGroupPath(path: string[]) {
  return path[0] === 'invites' || (path[0] === 'groups' && path[2] !== 'rounds')
}

export async function getGroupResponse(request: NextRequest, path: string[]): Promise<Response> {
  try {
    const method = request.method
    const access = readRequestAccessToken(request)
    if (method !== 'GET' && !sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const key = request.headers.get('idempotency-key') ?? ''
    let affectedAudience: string[] | undefined
    let data: unknown
    if (path[0] === 'groups' && path.length === 1 && method === 'GET') data = await listGroups(access, request.nextUrl.searchParams)
    else if (path[0] === 'groups' && path.length === 1 && method === 'POST') data = await createGroup(access, key, await readJsonBody(request))
    else if (path[0] === 'groups' && path.length === 2 && method === 'GET') data = await getGroup(access, path[1])
    else if (path[0] === 'groups' && path.length === 2 && method === 'DELETE') data = await leaveGroup(access, key, path[1], userIds => { affectedAudience = userIds })
    else if (path[0] === 'groups' && path.length === 3 && path[2] === 'invites' && method === 'POST') data = await createInvite(access, key, path[1], await readJsonBody(request), userIds => { affectedAudience = userIds })
    else if (path[0] === 'groups' && path.length === 4 && path[2] === 'invites' && method === 'DELETE') data = await revokeInvite(access, key, path[1], path[3], userIds => { affectedAudience = userIds })
    else if (path[0] === 'invites' && path.length === 2 && method === 'GET') data = await getInvite(access, path[1])
    else if (path[0] === 'invites' && path.length === 3 && path[2] === 'accept' && method === 'POST') data = await acceptInvite(access, key, path[1], userIds => { affectedAudience = userIds })
    else throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
    if (method !== 'GET' && realtimeEnabled()) {
      const groupId = path.length === 1 || path[0] === 'invites' ? (data as GroupMutationResult).id : path[1]
      after(() => publishGroupInvalidation(groupId, affectedAudience))
    }
    return Response.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return errorResponse(error) }
}
