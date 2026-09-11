import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { currentTimestamp, safeReturnTo, type AccessToken } from './auth'
import { requireAccount } from './authorization'
import { withReadTransaction, withWriteTransaction, type Database } from './db'
import { AppError } from './errors'
import {
  createOpenBankingAuthorizationUrl, decryptOpenBankingSecret, disconnectOpenBankingUser,
  encryptOpenBankingSecret, exchangeOpenBankingCode, getOpenBankingConfig,
  issueOpenBankingServiceToken, listOpenBankingAccounts, OpenBankingError, refreshOpenBankingToken,
} from './openbanking'

type ConnectionStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECT_PENDING' | 'DISCONNECTED'
type Connection = {
  user_id: string; connection_id: string; environment: string; status: ConnectionStatus
  user_seq_no: string | null; access_token: string | null; refresh_token: string | null
  expires_at: string | null; refresh_expires_at: string | null; authenticated_at: string | null
  scope: string | null
  version: number; operation_id: string | null; operation_kind: string | null
  operation_outcome: string | null; operation_lease_until: string | null
  disconnect_attempts: number; disconnect_next_attempt_at: string | null
  verification_window_at: string | null; verification_count: number
}
type OAuthState = {
  state_hash: string; user_id: string; session_id: string; connection_id: string; environment: string
  return_to: string; expires_at: string; used_at: string | null; invalidated_at: string | null
  exchange_outcome: string | null; cleanup_user_seq_no: string | null; cleanup_access_token: string | null
  cleanup_refresh_token: string | null; cleanup_expires_at: string | null; cleanup_refresh_expires_at: string | null
  cleanup_scope: string | null
  cleanup_operation_id: string | null; cleanup_outcome: string | null
}
export type BankVerificationCapture = { connectionId: string; connectionVersion: number; bankVersion: number }
const unavailable = () => new AppError(503, 'openbanking_unavailable', '금융기관 연결을 처리하고 있어요. 잠시 후 다시 시도해 주세요')
const pending = () => new AppError(409, 'openbanking_disconnect_pending', '이전 계좌 연결을 정리하고 있어요. 정리가 끝나면 다시 연결해 주세요')
const reauth = () => new AppError(409, 'openbanking_reauth_required', '금융결제원 인증을 다시 진행해 주세요')
const contextFor = (userId: string, connectionId: string, token: 'access' | 'refresh') => `user:${userId}:${connectionId}:${token}`
const stateHash = (state: string) => createHash('sha256').update(state).digest('hex')

async function connectionFor(client: Database, userId: string): Promise<Connection | undefined> {
  return (await client.query('SELECT * FROM openbanking_connections WHERE user_id=$1', [userId])).rows[0]
}

function requireConnection(row: Connection | undefined): Connection {
  if (row?.status === 'DISCONNECT_PENDING') throw pending()
  if (row?.status === 'REAUTH_REQUIRED') throw reauth()
  if (!row || row.status !== 'CONNECTED') throw new AppError(409, 'openbanking_required', '먼저 금융결제원 계좌 연결을 진행해 주세요')
  if (row.environment !== getOpenBankingConfig().environment) throw unavailable()
  return row
}

export async function getOpenBankingStatus(client: Database, userId: string) {
  const row = await connectionFor(client, userId)
  return { status: row?.status ?? 'NOT_CONNECTED' as ConnectionStatus, authenticatedAt: row?.authenticated_at ? Number(row.authenticated_at) : null,
    environment: row?.environment ?? (process.env.OPENBANKING_ENV === 'production' ? 'production' : 'test') }
}

async function unresolvedOAuth(client: Database, userId: string) {
  await client.query(`UPDATE openbanking_oauth_states SET exchange_outcome='unknown'
    WHERE user_id=$1 AND exchange_outcome='in_progress' AND exchange_started_at<$2`, [userId, currentTimestamp() - 30])
  return (await client.query('SELECT 1 FROM openbanking_oauth_states WHERE user_id=$1 AND exchange_outcome IS NOT NULL LIMIT 1', [userId])).rowCount !== 0
}

async function unfinishedWithdrawalAuthorization(client: Database, userId: string) {
  // Issuing an authorization URL does not tell us whether the provider later obtained consent.
  return (await client.query(`SELECT 1 FROM openbanking_oauth_states WHERE user_id=$1
    AND (exchange_outcome IS NOT NULL OR used_at IS NULL) LIMIT 1`, [userId])).rowCount !== 0
}

async function recoverCompletedAuthorization(client: Database, userId: string) {
  const connection = await connectionFor(client, userId)
  if (connection?.status === 'DISCONNECT_PENDING') throw pending()
  if (connection?.operation_outcome || await unresolvedOAuth(client, userId)) throw unavailable()
  const orphan = (await client.query(`SELECT * FROM openbanking_oauth_states WHERE user_id=$1
    AND cleanup_access_token IS NOT NULL AND cleaned_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0] as OAuthState | undefined
  if (!orphan) return
  if (orphan.cleanup_outcome || !orphan.cleanup_user_seq_no || orphan.environment !== getOpenBankingConfig().environment
    || (connection?.user_seq_no && connection.status !== 'DISCONNECTED' && connection.user_seq_no !== orphan.cleanup_user_seq_no)) throw unavailable()
  // The exchange completed for this same member. A fresh Kakao session may recover it without a second provider grant.
  await client.query(`INSERT INTO openbanking_connections(user_id,connection_id,environment,status,user_seq_no,access_token,refresh_token,expires_at,refresh_expires_at,scope,authenticated_at)
    VALUES($1,$2,$3,'CONNECTED',$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(user_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,environment=EXCLUDED.environment,status='CONNECTED',
      user_seq_no=EXCLUDED.user_seq_no,access_token=EXCLUDED.access_token,refresh_token=EXCLUDED.refresh_token,expires_at=EXCLUDED.expires_at,
      refresh_expires_at=EXCLUDED.refresh_expires_at,scope=EXCLUDED.scope,authenticated_at=EXCLUDED.authenticated_at,version=openbanking_connections.version+1`,
  [userId, orphan.connection_id, orphan.environment, orphan.cleanup_user_seq_no, orphan.cleanup_access_token, orphan.cleanup_refresh_token,
    orphan.cleanup_expires_at, orphan.cleanup_refresh_expires_at, orphan.cleanup_scope ?? getOpenBankingConfig().scope, currentTimestamp()])
  await client.query(`UPDATE openbanking_oauth_states SET cleanup_access_token=NULL,cleanup_refresh_token=NULL,
    cleaned_at=$2 WHERE state_hash=$1`, [orphan.state_hash, currentTimestamp()])
}

// The lease identifies the owner; expiration alone cannot establish the result of a remote mutation.
async function ensureConnection(access: AccessToken | null, allowOnboarding: boolean) {
  const claim = await withWriteTransaction(async client => {
    const account = await requireAccount(client, access, allowOnboarding)
    const row = requireConnection(await connectionFor(client, account.id))
    if (row.operation_outcome) {
      if (row.operation_outcome === 'in_progress' && Number(row.operation_lease_until) <= currentTimestamp()) {
        await client.query("UPDATE openbanking_connections SET operation_outcome='unknown',operation_lease_until=NULL WHERE user_id=$1", [account.id])
      }
      return { error: unavailable() }
    }
    if (Number(row.expires_at) > currentTimestamp() + 30) return { row }
    if (!row.refresh_token || (row.refresh_expires_at && Number(row.refresh_expires_at) <= currentTimestamp())) {
      await client.query("UPDATE openbanking_connections SET status='REAUTH_REQUIRED',version=version+1 WHERE user_id=$1", [account.id])
      return { error: reauth() }
    }
    const operationId = randomUUID()
    await client.query(`UPDATE openbanking_connections SET operation_id=$2,operation_kind='refresh',
      operation_started_at=$3,operation_finished_at=NULL,operation_outcome='in_progress',operation_lease_until=$3::bigint+30 WHERE user_id=$1`, [account.id, operationId, currentTimestamp()])
    return { row, operationId }
  })
  if (claim.error) throw claim.error
  const row = claim.row!
  if (!claim.operationId) return row
  let tokens: Awaited<ReturnType<typeof refreshOpenBankingToken>>
  try {
    tokens = await refreshOpenBankingToken(decryptOpenBankingSecret(row.refresh_token!, contextFor(row.user_id, row.connection_id, 'refresh')), row.scope ?? undefined)
  } catch (error) {
    await withWriteTransaction(async client => {
      await client.query(`UPDATE openbanking_connections SET operation_outcome=$3,operation_finished_at=$4,
        operation_lease_until=NULL,status=CASE WHEN $5 AND status='CONNECTED' THEN 'REAUTH_REQUIRED' ELSE status END,
        version=version+CASE WHEN $5 THEN 1 ELSE 0 END
        WHERE user_id=$1 AND operation_id=$2`, [row.user_id, claim.operationId,
        error instanceof OpenBankingError && error.remoteOutcome === 'rejected' ? null : 'unknown', currentTimestamp(), error instanceof OpenBankingError && error.reauth])
    })
    throw error
  }
  const result = await withWriteTransaction(async client => {
    const current = await connectionFor(client, row.user_id)
    if (!current || current.connection_id !== row.connection_id || current.operation_id !== claim.operationId) throw unavailable()
    if (tokens.userSeqNo && tokens.userSeqNo !== row.user_seq_no) {
      await client.query("UPDATE openbanking_connections SET operation_outcome='unknown',operation_lease_until=NULL WHERE user_id=$1", [row.user_id])
      return { error: unavailable() }
    }
    await client.query(`UPDATE openbanking_connections SET access_token=$2,refresh_token=$3,expires_at=$4,
      refresh_expires_at=$5,scope=$6,version=version+1,operation_outcome=NULL,operation_lease_until=NULL,operation_finished_at=$7 WHERE user_id=$1`, [row.user_id,
      encryptOpenBankingSecret(tokens.accessToken, contextFor(row.user_id, row.connection_id, 'access')),
      tokens.refreshToken ? encryptOpenBankingSecret(tokens.refreshToken, contextFor(row.user_id, row.connection_id, 'refresh')) : row.refresh_token,
      tokens.expiresAt, tokens.refreshExpiresAt ?? row.refresh_expires_at, tokens.scope, currentTimestamp()])
    if (current.status === 'DISCONNECT_PENDING') return { error: pending() }
    return { row: await connectionFor(client, row.user_id) }
  })
  if (result.error) throw result.error
  return result.row!
}

export async function getRegisteredBankAccounts(access: AccessToken | null) {
  const row = await ensureConnection(access, true)
  let accounts: Awaited<ReturnType<typeof listOpenBankingAccounts>>
  try {
    accounts = await listOpenBankingAccounts(
      decryptOpenBankingSecret(row.access_token!, contextFor(row.user_id, row.connection_id, 'access')), row.user_seq_no!,
    )
  } catch (error) {
    if (error instanceof OpenBankingError && error.reauth) {
      await withWriteTransaction(client => client.query(`UPDATE openbanking_connections SET status='REAUTH_REQUIRED',version=version+1
        WHERE user_id=$1 AND connection_id=$2 AND version=$3 AND environment=$4 AND status='CONNECTED' AND operation_outcome IS NULL`,
      [row.user_id, row.connection_id, row.version, row.environment]))
    }
    throw error
  }
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access, true)
    const current = requireConnection(await connectionFor(client, account.id))
    if (account.id !== row.user_id || current.connection_id !== row.connection_id || current.version !== row.version
      || current.environment !== row.environment || current.operation_outcome) throw unavailable()
    return accounts
  })
}

export async function startOpenBanking(access: AccessToken | null, context: 'onboarding' | 'settings', returnTo?: unknown) {
  if (!['onboarding', 'settings'].includes(context)) throw new AppError(400, 'invalid_input', '인증을 시작한 화면을 확인해 주세요')
  const account = await withWriteTransaction(async client => {
    const current = await requireAccount(client, access, true)
    if ((context === 'onboarding') !== (current.purpose === 'onboarding')) throw new AppError(403, 'forbidden', '현재 화면에서 인증을 다시 시작해 주세요')
    await recoverCompletedAuthorization(client, current.id)
    return current
  })
  if ((context === 'onboarding') !== (account.purpose === 'onboarding')) throw new AppError(403, 'forbidden', '현재 화면에서 인증을 다시 시작해 주세요')
  const destination = context === 'onboarding' ? `/onboarding?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}&verify=1` : `${safeReturnTo(returnTo)}?account=1&verify=1`
  const status = await withReadTransaction(client => getOpenBankingStatus(client, account.id))
  if (status.status === 'CONNECTED') {
    try {
      await ensureConnection(access, true)
      return { returnTo: destination }
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'openbanking_reauth_required') throw error
    }
  }
  const state = randomBytes(24).toString('base64url')
  const authorizationUrl = createOpenBankingAuthorizationUrl(state)
  await withWriteTransaction(async client => {
    await requireAccount(client, access, true)
    const existing = await connectionFor(client, account.id)
    if (existing?.status === 'DISCONNECT_PENDING') throw pending()
    if (existing?.operation_outcome || await unresolvedOAuth(client, account.id)) throw unavailable()
    // A concurrent successful callback wins; starting another state must not replace its consent.
    if (existing?.status === 'CONNECTED') throw new AppError(409, 'openbanking_already_connected', '계좌 연결이 완료됐어요. 상태를 새로 확인해 주세요')
    const now = currentTimestamp()
    await client.query('UPDATE openbanking_oauth_states SET invalidated_at=$2 WHERE user_id=$1 AND invalidated_at IS NULL', [account.id, now])
    await client.query(`INSERT INTO openbanking_oauth_states(state_hash,user_id,session_id,connection_id,environment,context,return_to,created_at,expires_at)
      SELECT $1,$2,s.id,$4,$5,$6,$7,$8,LEAST(s.expires_at,$8::bigint+600) FROM refresh_sessions s WHERE s.id=$3`,
    [stateHash(state), account.id, access!.sessionId, existing && existing.status !== 'DISCONNECTED' ? existing.connection_id : randomUUID(), getOpenBankingConfig().environment, context, destination, now])
  })
  return { authorizationUrl }
}

export async function completeOpenBanking(access: AccessToken | null, state: string, callback: { code?: string; error?: string }) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) throw new AppError(400, 'invalid_input', '금융결제원 인증을 다시 시작해 주세요')
  const row: OAuthState = await withWriteTransaction(async client => {
    const record = (await client.query('SELECT * FROM openbanking_oauth_states WHERE state_hash=$1', [stateHash(state)])).rows[0] as OAuthState | undefined
    if (!record || record.used_at) {
      throw new AppError(400, 'invalid_input', '만료되었거나 이미 사용한 인증이에요. 다시 시작해 주세요')
    }
    const connection = await connectionFor(client, record.user_id)
    const cleanup = connection?.status === 'DISCONNECT_PENDING' && record.invalidated_at !== null
    if (cleanup) {
      if (access && access.userId !== record.user_id) throw new AppError(400, 'invalid_input', '인증을 시작한 계정을 확인해 주세요')
      // Withdrawal has revoked the original session. A late code may only supply cleanup credentials.
      // No current/new connection can be activated through this branch, even with a fresh rejoin session.
    } else {
      const account = await requireAccount(client, access, true)
      if (record.user_id !== account.id || record.session_id !== access!.sessionId || record.invalidated_at || Number(record.expires_at) <= currentTimestamp()) {
        throw new AppError(400, 'invalid_input', '만료되었거나 이미 사용한 인증이에요. 다시 시작해 주세요')
      }
    }
    if (record.environment !== getOpenBankingConfig().environment) throw unavailable()
    if (!callback.error && (!callback.code || callback.code.length > 2048)) throw new AppError(400, 'invalid_input', '인증 응답을 확인할 수 없어요. 다시 시작해 주세요')
    await client.query(`UPDATE openbanking_oauth_states SET used_at=$2,exchange_started_at=$3,
      exchange_outcome=$4 WHERE state_hash=$1`, [record.state_hash, currentTimestamp(), callback.error ? null : currentTimestamp(), callback.error ? null : 'in_progress'])
    return record
  })
  if (callback.error) return { returnTo: row.return_to, error: callback.error === 'A0019' ? 'openbanking_provider_pending' : 'openbanking_cancelled' }
  let tokens: Awaited<ReturnType<typeof exchangeOpenBankingCode>>
  try {
    tokens = await exchangeOpenBankingCode(callback.code!)
  } catch (error) {
    await withWriteTransaction(client => client.query(`UPDATE openbanking_oauth_states SET exchange_finished_at=$2,exchange_outcome=$3 WHERE state_hash=$1`,
      [row.state_hash, currentTimestamp(), error instanceof OpenBankingError && error.remoteOutcome === 'rejected' ? null : 'unknown']))
    return { returnTo: row.return_to, error: error instanceof OpenBankingError && error.providerCode === 'A0019' ? 'openbanking_provider_pending' : 'openbanking_unavailable' }
  }
  const accepted = await withWriteTransaction(async client => {
    const now = currentTimestamp()
    const currentState = (await client.query('SELECT * FROM openbanking_oauth_states WHERE state_hash=$1', [row.state_hash])).rows[0] as OAuthState
    const connection = await connectionFor(client, row.user_id)
    const session = (await client.query(`SELECT u.deleted_at,s.purpose FROM refresh_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3`, [row.session_id, row.user_id, now])).rows[0]
    const canApply = session && (session.deleted_at === null || session.purpose === 'onboarding') && !currentState.invalidated_at
      && connection?.status !== 'DISCONNECT_PENDING' && tokens.userSeqNo
      && (!connection?.user_seq_no || connection.status === 'DISCONNECTED' || connection.user_seq_no === tokens.userSeqNo)
    await client.query(`UPDATE openbanking_oauth_states SET exchange_finished_at=$2,exchange_outcome=NULL,
      cleanup_user_seq_no=$3,cleanup_access_token=$4,cleanup_refresh_token=$5,cleanup_expires_at=$6,cleanup_refresh_expires_at=$7,cleanup_scope=$8 WHERE state_hash=$1`,
    [row.state_hash, now, canApply ? null : tokens.userSeqNo,
      canApply ? null : encryptOpenBankingSecret(tokens.accessToken, contextFor(row.user_id, row.connection_id, 'access')),
      canApply || !tokens.refreshToken ? null : encryptOpenBankingSecret(tokens.refreshToken, contextFor(row.user_id, row.connection_id, 'refresh')),
      canApply ? null : tokens.expiresAt, canApply ? null : tokens.refreshExpiresAt, canApply ? null : tokens.scope])
    if (!canApply) return false
    await client.query(`INSERT INTO openbanking_connections(user_id,connection_id,environment,status,user_seq_no,access_token,refresh_token,expires_at,refresh_expires_at,scope,authenticated_at)
      VALUES($1,$2,$3,'CONNECTED',$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(user_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,environment=EXCLUDED.environment,status='CONNECTED',
      user_seq_no=EXCLUDED.user_seq_no,access_token=EXCLUDED.access_token,refresh_token=EXCLUDED.refresh_token,expires_at=EXCLUDED.expires_at,
      refresh_expires_at=EXCLUDED.refresh_expires_at,scope=EXCLUDED.scope,authenticated_at=EXCLUDED.authenticated_at,version=openbanking_connections.version+1,
      operation_id=NULL,operation_kind=NULL,operation_outcome=NULL,operation_lease_until=NULL,disconnect_requested_at=NULL,
      disconnect_next_attempt_at=NULL,disconnect_attempts=0,disconnect_last_error=NULL,disconnected_at=NULL`,
    [row.user_id, row.connection_id, row.environment, tokens.userSeqNo,
      encryptOpenBankingSecret(tokens.accessToken, contextFor(row.user_id, row.connection_id, 'access')),
      tokens.refreshToken ? encryptOpenBankingSecret(tokens.refreshToken, contextFor(row.user_id, row.connection_id, 'refresh')) : null,
      tokens.expiresAt, tokens.refreshExpiresAt, tokens.scope, now])
    return true
  })
  return { returnTo: row.return_to, ...(accepted ? {} : { error: 'openbanking_unavailable' }) }
}

export async function prepareBankVerification(access: AccessToken | null, expectedVersion: number, allowOnboarding = false): Promise<BankVerificationCapture> {
  await ensureConnection(access, allowOnboarding)
  return withWriteTransaction(async client => {
    const account = await requireAccount(client, access, allowOnboarding)
    const row = requireConnection(await connectionFor(client, account.id))
    if (row.operation_outcome || Number(row.expires_at) <= currentTimestamp()) throw unavailable()
    if (account.bankVersion !== expectedVersion) throw new AppError(409, 'bank_account_conflict', '계좌가 변경됐어요. 최신 계좌를 확인하고 다시 입력해 주세요')
    const now = currentTimestamp()
    const reset = !row.verification_window_at || Number(row.verification_window_at) + 300 <= now
    if (!reset && row.verification_count >= 10) throw new AppError(429, 'bank_verification_rate_limited', '계좌 확인 요청이 많아요. 잠시 후 다시 시도해 주세요', { retryAfter: Number(row.verification_window_at) + 300 - now })
    await client.query('UPDATE openbanking_connections SET verification_window_at=$2,verification_count=$3 WHERE user_id=$1', [account.id, reset ? now : row.verification_window_at, reset ? 1 : row.verification_count + 1])
    return { connectionId: row.connection_id, connectionVersion: row.version, bankVersion: account.bankVersion }
  })
}

export async function assertBankVerification(client: Database, access: AccessToken | null, capture: BankVerificationCapture, expectedVersion: number, allowOnboarding = false) {
  const account = await requireAccount(client, access, allowOnboarding)
  const row = requireConnection(await connectionFor(client, account.id))
  if (row.connection_id !== capture.connectionId || row.version !== capture.connectionVersion || row.operation_outcome) throw unavailable()
  if (account.bankVersion !== expectedVersion || account.bankVersion !== capture.bankVersion) throw new AppError(409, 'bank_account_conflict', '계좌가 변경됐어요. 최신 계좌를 확인하고 다시 입력해 주세요')
  return account
}

export async function getServiceToken(): Promise<string> {
  const environment = getOpenBankingConfig().environment
  const claim = await withWriteTransaction(async client => {
    await client.query('INSERT INTO openbanking_service_tokens(environment) VALUES($1) ON CONFLICT DO NOTHING', [environment])
    const row = (await client.query('SELECT * FROM openbanking_service_tokens WHERE environment=$1', [environment])).rows[0]
    if (row.access_token && Number(row.expires_at) > currentTimestamp() + 30) return { token: decryptOpenBankingSecret(row.access_token, `service:${environment}`) }
    // An institution credential has no member-consent/payment side effect. Recover its expired
    // issuance lease; a late former owner's token cannot replace this operation's result.
    if (row.operation_outcome && Number(row.lease_until) > currentTimestamp()) throw unavailable()
    const operationId = randomUUID()
    await client.query("UPDATE openbanking_service_tokens SET operation_id=$2,operation_outcome='in_progress',lease_until=$3::bigint+30 WHERE environment=$1", [environment, operationId, currentTimestamp()])
    return { operationId }
  })
  if (claim.token) return claim.token
  let token: Awaited<ReturnType<typeof issueOpenBankingServiceToken>>
  try { token = await issueOpenBankingServiceToken() } catch (error) {
    await withWriteTransaction(client => client.query('UPDATE openbanking_service_tokens SET operation_outcome=$3,lease_until=CASE WHEN $3::text IS NULL THEN NULL ELSE lease_until END WHERE environment=$1 AND operation_id=$2',
      [environment, claim.operationId, error instanceof OpenBankingError && error.remoteOutcome === 'rejected' ? null : 'unknown']))
    throw error
  }
  await withWriteTransaction(async client => {
    const result = await client.query(`UPDATE openbanking_service_tokens SET access_token=$3,expires_at=$4,version=version+1,
      operation_outcome=NULL,lease_until=NULL WHERE environment=$1 AND operation_id=$2`,
    [environment, claim.operationId, encryptOpenBankingSecret(token.accessToken, `service:${environment}`), token.expiresAt])
    if (!result.rowCount) throw unavailable()
  })
  return token.accessToken
}

export async function invalidateServiceToken(token: string) {
  const environment = getOpenBankingConfig().environment
  await withWriteTransaction(async client => {
    const row = (await client.query('SELECT access_token FROM openbanking_service_tokens WHERE environment=$1', [environment])).rows[0]
    if (row?.access_token && decryptOpenBankingSecret(row.access_token, `service:${environment}`) === token) {
      await client.query('UPDATE openbanking_service_tokens SET access_token=NULL,expires_at=NULL WHERE environment=$1', [environment])
    }
  })
}

export async function allocateBankTranId() {
  const sequence = await withWriteTransaction(async client => (await client.query("SELECT nextval('openbanking_bank_tran_seq') AS value")).rows[0].value)
  return `${getOpenBankingConfig().clientUseCode}U${BigInt(sequence).toString(36).toUpperCase().padStart(9, '0')}`
}

export async function requestDisconnect(client: Database, userId: string): Promise<'pending' | 'completed'> {
  const now = currentTimestamp()
  await client.query('UPDATE openbanking_oauth_states SET invalidated_at=COALESCE(invalidated_at,$2) WHERE user_id=$1', [userId, now])
  const connection = await connectionFor(client, userId)
  const unfinished = (await client.query(`SELECT * FROM openbanking_oauth_states WHERE user_id=$1
    AND (used_at IS NULL OR exchange_outcome IS NOT NULL OR (cleanup_access_token IS NOT NULL AND cleaned_at IS NULL)) ORDER BY created_at LIMIT 1`, [userId])).rows[0] as OAuthState | undefined
  if ((!connection || connection.status === 'DISCONNECTED') && !unfinished) return 'completed'
  if (!connection) {
    await client.query(`INSERT INTO openbanking_connections(user_id,connection_id,environment,status,disconnect_requested_at,disconnect_next_attempt_at)
      VALUES($1,$2,$3,'DISCONNECT_PENDING',$4,$4)`, [userId, randomUUID(), unfinished!.environment, now])
  } else {
    await client.query(`UPDATE openbanking_connections SET status='DISCONNECT_PENDING',version=version+1,
      disconnect_requested_at=COALESCE(disconnect_requested_at,$2),disconnect_next_attempt_at=COALESCE(disconnect_next_attempt_at,$2) WHERE user_id=$1`, [userId, now])
  }
  return 'pending'
}

async function disconnectOne(userId: string, remaining = 10): Promise<'completed' | 'pending' | 'skipped'> {
  if (!remaining) return 'pending'
  const claim = await withWriteTransaction(async client => {
    const row = await connectionFor(client, userId)
    if (!row || row.status !== 'DISCONNECT_PENDING') return { result: 'skipped' as const }
    if (row.environment !== getOpenBankingConfig().environment) return { result: 'pending' as const }
    if (row.operation_outcome) {
      if (row.operation_outcome === 'in_progress' && Number(row.operation_lease_until) <= currentTimestamp()) {
        await client.query(`UPDATE openbanking_connections SET operation_outcome='unknown',operation_lease_until=NULL,
          disconnect_last_error='remote_result_unknown' WHERE user_id=$1`, [userId])
      }
      return { result: 'pending' as const }
    }
    if (row.disconnect_next_attempt_at === null || Number(row.disconnect_next_attempt_at) > currentTimestamp() || await unfinishedWithdrawalAuthorization(client, userId)) return { result: 'pending' as const }
    const orphan = (await client.query(`SELECT * FROM openbanking_oauth_states WHERE user_id=$1 AND cleanup_access_token IS NOT NULL AND cleaned_at IS NULL ORDER BY created_at LIMIT 1`, [userId])).rows[0] as OAuthState | undefined
    if (orphan?.cleanup_outcome) return { result: 'pending' as const }
    if (!orphan && !row.access_token) {
      await client.query(`UPDATE openbanking_connections SET status='DISCONNECTED',refresh_token=NULL,disconnected_at=$2,
        disconnect_next_attempt_at=NULL,disconnect_last_error=NULL,version=version+1 WHERE user_id=$1`, [userId, currentTimestamp()])
      return { result: 'completed' as const }
    }
    const operationId = randomUUID()
    const refresh = Number(orphan ? orphan.cleanup_expires_at : row.expires_at) <= currentTimestamp() + 30
    await client.query(`UPDATE openbanking_connections SET operation_id=$2,operation_kind=$4,operation_started_at=$3,
      operation_finished_at=NULL,operation_outcome='in_progress',operation_lease_until=$3::bigint+30,disconnect_attempts=disconnect_attempts+1 WHERE user_id=$1`, [userId, operationId, currentTimestamp(), refresh ? 'refresh' : 'disconnect'])
    if (orphan) await client.query("UPDATE openbanking_oauth_states SET cleanup_operation_id=$2,cleanup_started_at=$3,cleanup_outcome='in_progress' WHERE state_hash=$1", [orphan.state_hash, operationId, currentTimestamp()])
    return { row, orphan, operationId, refresh }
  })
  if (claim.result) return claim.result
  const { row, orphan, operationId, refresh } = claim
  let refreshed: Awaited<ReturnType<typeof refreshOpenBankingToken>> | undefined
  try {
    const source = orphan
      ? { id: orphan.connection_id, token: orphan.cleanup_access_token, subject: orphan.cleanup_user_seq_no, refreshToken: orphan.cleanup_refresh_token, refreshExpiresAt: orphan.cleanup_refresh_expires_at }
      : { id: row!.connection_id, token: row!.access_token, subject: row!.user_seq_no, refreshToken: row!.refresh_token, refreshExpiresAt: row!.refresh_expires_at }
    if (!source.token || !source.subject) throw unavailable()
    if (refresh) {
      if (!source.refreshToken || (source.refreshExpiresAt && Number(source.refreshExpiresAt) <= currentTimestamp())) {
        // Expiration is not evidence of withdrawal; retain the grant for operator-assisted cleanup.
        await withWriteTransaction(client => client.query(`UPDATE openbanking_connections SET operation_outcome=NULL,operation_lease_until=NULL,
          disconnect_next_attempt_at=NULL,disconnect_last_error='cleanup_token_expired' WHERE user_id=$1 AND operation_id=$2`, [userId, operationId]))
        if (orphan) await withWriteTransaction(client => client.query('UPDATE openbanking_oauth_states SET cleanup_outcome=NULL WHERE state_hash=$1 AND cleanup_operation_id=$2', [orphan.state_hash, operationId]))
        return 'pending'
      }
      refreshed = await refreshOpenBankingToken(decryptOpenBankingSecret(source.refreshToken, contextFor(userId, source.id, 'refresh')), (orphan ? orphan.cleanup_scope : row!.scope) ?? undefined)
      if (refreshed.userSeqNo && refreshed.userSeqNo !== source.subject) throw unavailable()
    } else {
      await disconnectOpenBankingUser({ accessToken: decryptOpenBankingSecret(source.token, contextFor(userId, source.id, 'access')), userSeqNo: source.subject })
    }
  } catch (error) {
    const known = error instanceof OpenBankingError
    const unknown = !known || error.remoteOutcome !== 'rejected'
    const retry = known && error.retryable && !unknown
    await withWriteTransaction(async client => {
      await client.query(`UPDATE openbanking_connections SET operation_outcome=$3,operation_finished_at=$4,operation_lease_until=NULL,
        disconnect_next_attempt_at=$5,disconnect_last_error=$6 WHERE user_id=$1 AND operation_id=$2`,
      [userId, operationId, unknown ? 'unknown' : null, currentTimestamp(), retry ? currentTimestamp() + Math.min(30, 2 ** Math.min(row!.disconnect_attempts, 5)) * 60 : null,
        unknown ? 'remote_result_unknown' : retry ? 'provider_temporarily_unavailable' : 'provider_configuration_required'])
      if (orphan) await client.query('UPDATE openbanking_oauth_states SET cleanup_outcome=$3 WHERE state_hash=$1 AND cleanup_operation_id=$2', [orphan.state_hash, operationId, unknown ? 'unknown' : null])
    })
    return 'pending'
  }
  await withWriteTransaction(async client => {
    const current = await connectionFor(client, userId)
    if (current?.status !== 'DISCONNECT_PENDING' || current.connection_id !== row!.connection_id || current.operation_id !== operationId) throw unavailable()
    if (refreshed) {
      const targetId = orphan?.connection_id ?? row!.connection_id
      const encryptedAccess = encryptOpenBankingSecret(refreshed.accessToken, contextFor(userId, targetId, 'access'))
      const encryptedRefresh = refreshed.refreshToken ? encryptOpenBankingSecret(refreshed.refreshToken, contextFor(userId, targetId, 'refresh')) : null
      if (orphan) {
        await client.query(`UPDATE openbanking_oauth_states SET cleanup_access_token=$2,cleanup_refresh_token=COALESCE($3,cleanup_refresh_token),
          cleanup_expires_at=$4,cleanup_refresh_expires_at=COALESCE($5,cleanup_refresh_expires_at),cleanup_outcome=NULL WHERE state_hash=$1`,
        [orphan.state_hash, encryptedAccess, encryptedRefresh, refreshed.expiresAt, refreshed.refreshExpiresAt])
      } else {
        await client.query(`UPDATE openbanking_connections SET access_token=$2,refresh_token=COALESCE($3,refresh_token),expires_at=$4,
          refresh_expires_at=COALESCE($5,refresh_expires_at),scope=$6,version=version+1 WHERE user_id=$1`,
        [userId, encryptedAccess, encryptedRefresh, refreshed.expiresAt, refreshed.refreshExpiresAt, refreshed.scope])
      }
      await client.query(`UPDATE openbanking_connections SET operation_outcome=NULL,operation_lease_until=NULL,operation_finished_at=$2,
        disconnect_next_attempt_at=$2,disconnect_last_error=NULL WHERE user_id=$1`, [userId, currentTimestamp()])
      return
    }
    const closedSubject = orphan?.cleanup_user_seq_no ?? row!.user_seq_no
    // user/close closes this member's entire provider registration. Reusing its now-revoked older token
    // may fail at authentication before the API can return 'already withdrawn'. Clear all known grants it covers.
    await client.query(`UPDATE openbanking_oauth_states SET cleanup_access_token=NULL,cleanup_refresh_token=NULL,
      cleanup_outcome=NULL,cleaned_at=$4 WHERE user_id=$1 AND environment=$2 AND cleanup_user_seq_no=$3`, [userId, row!.environment, closedSubject, currentTimestamp()])
    await client.query(`UPDATE openbanking_connections SET access_token=CASE WHEN user_seq_no=$3 THEN NULL ELSE access_token END,
      refresh_token=CASE WHEN user_seq_no=$3 THEN NULL ELSE refresh_token END,
      expires_at=CASE WHEN user_seq_no=$3 THEN NULL ELSE expires_at END,
      refresh_expires_at=CASE WHEN user_seq_no=$3 THEN NULL ELSE refresh_expires_at END,
      operation_outcome=NULL,operation_lease_until=NULL,operation_finished_at=$2,disconnect_next_attempt_at=$2,disconnect_last_error=NULL WHERE user_id=$1`, [userId, currentTimestamp(), closedSubject])
  })
  return disconnectOne(userId, remaining - 1)
}

export async function retryDisconnect(userId?: string, options: { retryRejected?: boolean } = {}) {
  if (options.retryRejected) {
    await withWriteTransaction(client => client.query(`UPDATE openbanking_connections SET disconnect_next_attempt_at=$2
      WHERE status='DISCONNECT_PENDING' AND operation_outcome IS NULL
        AND disconnect_last_error IN ('provider_configuration_required','cleanup_token_expired')
        AND ($1::text IS NULL OR user_id=$1)`, [userId ?? null, currentTimestamp()]))
  }
  const ids = await withReadTransaction(async client => (await client.query(`SELECT user_id FROM openbanking_connections
    WHERE status='DISCONNECT_PENDING' AND ($1::text IS NULL OR user_id=$1)
      AND ($1::text IS NOT NULL OR (disconnect_next_attempt_at IS NOT NULL AND disconnect_next_attempt_at<=$2))
    ORDER BY operation_outcome NULLS FIRST,disconnect_next_attempt_at,disconnect_requested_at LIMIT 100`, [userId ?? null, currentTimestamp()])).rows.map(row => String(row.user_id)))
  const counts = { completed: 0, pending: 0, skipped: 0 }
  for (const id of ids) {
    try { counts[await disconnectOne(id)]++ } catch { counts.pending++ }
  }
  const needsOperator = await withReadTransaction(async client => Number((await client.query(`SELECT count(*) AS count
    FROM openbanking_connections WHERE status='DISCONNECT_PENDING' AND ($1::text IS NULL OR user_id=$1)
      AND (disconnect_next_attempt_at IS NULL OR operation_outcome='unknown'
        OR (operation_outcome='in_progress' AND (operation_lease_until IS NULL OR operation_lease_until<=$2)))`,
  [userId ?? null, currentTimestamp()])).rows[0].count))
  return { ...counts, needsOperator }
}
