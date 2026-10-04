'use client'

import { ApiError, ErrorNotice as Notice } from '../../../../Global/Util/Frontend'

export function ErrorNotice({ error, retry }: { error: Error | null; retry?: () => void }) {
  const stale = error instanceof ApiError && error.code === 'stale_round'
  return <Notice error={error} retry={retry} hint={stale ? '다른 변경사항이 먼저 저장되었어요. 최신 내역을 확인한 뒤 다시 제출해 주세요. 입력한 내용은 유지돼요.' : undefined} retryLabel={stale ? '최신 내역 불러오기' : undefined} />
}
