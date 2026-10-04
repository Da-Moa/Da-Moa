import 'server-only'
import { badInput } from '../../../lib/errors'

export function textInput(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) badInput()
  return value.trim()
}

export function onlyKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) badInput('invalid_input', '지원하지 않는 입력 항목이 있어요')
}

export function idsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || id !== id.trim() || !/^[\w-]{1,128}$/.test(id)) || new Set(value).size !== value.length) {
    badInput('invalid_participants', '참여자를 중복 없이 선택해 주세요')
  }
  return (value as string[]).slice().sort()
}
