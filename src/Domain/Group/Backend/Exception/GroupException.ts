import 'server-only'
import { AppError } from '../../../../Global/Util/Backend'
import { MAX_GROUP_MEMBERS } from '../../Shared'

export const missing = () => new AppError(404, 'not_found', '요청한 자료를 찾을 수 없어요')
export const duplicateGroup = () => new AppError(409, 'group_already_exists', '이미 생성된 모임입니다. 모임 목록을 확인해 주세요')
export const alreadyMember = () => new AppError(409, 'group_already_member', '이미 참여 중인 모임입니다')
export const creatorOnly = () => new AppError(403, 'forbidden', '모임 생성자만 할 수 있어요')
export const unfinishedGroupRounds = () => new AppError(409, 'unfinished_group_rounds', '종료되지 않은 회차가 있어 모임을 없앨 수 없어요')
export const unfinishedRounds = () => new AppError(409, 'unfinished_rounds', '참여 중인 회차가 있어 모임에서 나갈 수 없어요')
export const memberLimitExceeded = () => new AppError(409, 'group_member_limit_exceeded', `모임은 생성자를 포함해 최대 ${MAX_GROUP_MEMBERS}명까지 참여할 수 있어요`)
