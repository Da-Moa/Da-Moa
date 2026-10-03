import 'server-only'
import { AppError } from '../../../../Global/Util/Backend'

export const missing = () => new AppError(404, 'not_found', '요청한 자료를 찾을 수 없어요')

export const duplicateRound = () => new AppError(409, 'round_already_exists', '이미 생성된 회차입니다. 회차 목록을 확인해 주세요')
