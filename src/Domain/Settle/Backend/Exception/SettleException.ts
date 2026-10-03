import 'server-only'
import { AppError } from '../../../../Global/Util/Backend'

export const missing = () => new AppError(404, 'not_found', '요청한 자료를 찾을 수 없어요')
