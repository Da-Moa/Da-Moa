import type { RoundStatus } from '../../Shared'

export const statusLabel: Record<RoundStatus, string> = { RECORDING: '기록 중', CONFIRMED: '확정 · 전송 전', LOCKED: '송금 대기중', COMPLETED: '정산 종료' }
export function StatusBadge({ status }: { status: RoundStatus }) { return <span className={`status-badge state-${status.toLowerCase()}`}>{statusLabel[status]}</span> }
