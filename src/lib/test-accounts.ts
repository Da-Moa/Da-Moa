export const TEST_ACCOUNTS = [
  {
    key: 'member-a',
    id: '00000000-0000-4000-8000-000000000001',
    providerSubject: 'da-moa:test-only:member-a',
    displayName: '테스트 민지',
    email: 'minji@da-moa.example.invalid',
    bankName: '테스트은행 A',
    accountNumber: '000000000001',
    accountHolder: '테스트 민지',
  },
  {
    key: 'member-b',
    id: '00000000-0000-4000-8000-000000000002',
    providerSubject: 'da-moa:test-only:member-b',
    displayName: '테스트 준호',
    email: 'junho@da-moa.example.invalid',
    bankName: '테스트은행 B',
    accountNumber: '000000000002',
    accountHolder: '테스트 준호',
  },
  {
    key: 'member-c',
    id: '00000000-0000-4000-8000-000000000003',
    providerSubject: 'da-moa:test-only:member-c',
    displayName: '테스트 서연',
    email: 'seoyeon@da-moa.example.invalid',
    bankName: '테스트은행 C',
    accountNumber: '000000000003',
    accountHolder: '테스트 서연',
  },
  {
    key: 'member-d',
    id: '00000000-0000-4000-8000-000000000004',
    providerSubject: 'da-moa:test-only:member-d',
    displayName: '테스트 지우',
    email: 'jiwoo@da-moa.example.invalid',
    bankName: '테스트은행 D',
    accountNumber: '000000000004',
    accountHolder: '테스트 지우',
  },
  {
    key: 'member-e',
    id: '00000000-0000-4000-8000-000000000005',
    providerSubject: 'da-moa:test-only:member-e',
    displayName: '테스트 현우',
    email: 'hyunwoo@da-moa.example.invalid',
    bankName: '테스트은행 E',
    accountNumber: '000000000005',
    accountHolder: '테스트 현우',
  },
] as const

export function testAccountForKey(value: unknown) {
  return typeof value === 'string' ? TEST_ACCOUNTS.find(account => account.key === value) : undefined
}

export function testLoginGuard(nodeEnv: string | undefined, hostname: string, origin: string | null, expectedOrigin: string) {
  if (nodeEnv === 'production' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return 404
  return origin === expectedOrigin ? null : 403
}
