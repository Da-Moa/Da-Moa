import 'server-only'
import { AppError } from '../../../../Global/Util/Backend'
import type { UnfinishedUserRound } from '../../../Settle/Shared'

export const bankAccountConflict = () => new AppError(409, 'bank_account_conflict', '계좌가 변경됐어요. 최신 계좌를 확인하고 다시 입력해 주세요')
export const alreadyOnboarded = () => new AppError(409, 'already_onboarded', '이미 가입을 완료했습니다')
export const rejoinConfirmationRequired = () => new AppError(400, 'rejoin_confirmation_required', '이전 기록을 유지하여 재가입하는 데 동의해 주세요')
export const unfinishedRounds = (rounds: UnfinishedUserRound[]) => new AppError(409, 'unfinished_rounds', '진행 중인 정산이 있어 탈퇴할 수 없습니다', { rounds })
