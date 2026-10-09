'use client'

import { ApiError, ErrorNotice as Notice } from '../../../global/util'

export function ErrorNotice({ error, retry }: { error: Error | null; retry?: () => void }) {
  const stale = error instanceof ApiError && error.code === 'bank_account_conflict'
  return <Notice error={error} retry={retry} hint={stale ? '다른 계좌 변경이 먼저 저장되었어요. 최신 계좌를 불러와 확인한 뒤 다시 입력해 주세요.' : undefined} retryLabel={stale ? '최신 내역 불러오기' : undefined} />
}
