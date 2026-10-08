const loginMessages: Record<string, string> = {
  configuration: '로그인 설정을 확인해 주세요',
  failed: '로그인을 완료하지 못했어요. 다시 시도해 주세요',
  invalid: '로그인 요청이 만료되었어요. 다시 시도해 주세요',
}

export function getLoginMessage(error: string | undefined) {
  if (!error) return undefined

  return Object.hasOwn(loginMessages, error) ? loginMessages[error] : loginMessages.failed
}
