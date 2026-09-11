import nextEnv from '@next/env'
import { getOpenBankingConfig, OpenBankingError } from '../src/lib/openbanking.ts'
import { getServiceToken } from '../src/lib/openbanking-store.ts'
import { withReadTransaction } from '../src/lib/db.ts'

nextEnv.loadEnvConfig(process.cwd())
const required = ['OPENBANKING_ENV', 'OPENBANKING_CLIENT_ID', 'OPENBANKING_CLIENT_SECRET', 'OPENBANKING_CLIENT_USE_CODE',
  'OPENBANKING_REDIRECT_URI', 'OPENBANKING_SCOPES', 'OPENBANKING_TOKEN_ENCRYPTION_KEY', 'OPENBANKING_REQUEST_HMAC_KEY']
const missing = required.filter(name => !process.env[name]?.trim())
try {
  if (process.argv.slice(2).some(argument => argument !== '--live')) throw new Error('Usage: npm run openbanking:check [-- --live]')
  if (missing.length) throw new Error(`필요한 환경 변수: ${missing.join(', ')}`)
  const config = getOpenBankingConfig()
  console.info(`환경 설정 확인: ${config.environment}, Callback ${config.redirectUri}`)
  if (process.argv.includes('--live')) {
    const applied = await withReadTransaction(client => client.query("SELECT 1 FROM schema_migrations WHERE version='009-openbanking.sql'"))
    if (!applied.rowCount) throw new Error('npm run db:migrate로 009 마이그레이션을 먼저 적용해 주세요')
    await getServiceToken()
    console.info('실제 금융결제원 기관 인증(oob) 토큰 준비 성공. 사용자 OAuth와 계좌실명조회는 브라우저에서 확인해 주세요.')
  } else {
    console.info('설정 형식만 확인했습니다. 외부 API와 DB는 호출하지 않았습니다.')
  }
} catch (error) {
  // Never print provider responses, tokens, keys, or database connection strings.
  console.error(error instanceof OpenBankingError ? `금융결제원 설정/인증 확인 실패: ${error.kind}${error.providerCode ? ` (${error.providerCode})` : ''}` : missing.length || error?.message?.startsWith('Usage:') || error?.message?.startsWith('npm run db:migrate') ? error.message : '설정 또는 DB 연결을 확인해 주세요')
  process.exitCode = 1
}
