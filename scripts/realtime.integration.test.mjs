import { uuidV7 } from '../src/lib/uuid.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import sharp from 'sharp'
import { createDatabaseClient } from '../src/lib/db.ts'
import { TEST_ACCOUNTS } from '../src/lib/test-accounts.ts'
import { applyMigrations } from './migrations.mjs'
import { ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, createAccessToken, createRefreshToken, currentTimestamp } from '../src/lib/auth.ts'

const database = process.env.TEST_DATABASE_URL
assert.ok(database && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) && new URL(database).pathname.toLowerCase().includes('test'))

test('authenticated WebSocket receives only its own committed invalidations', async () => {
  const db = createDatabaseClient(database)
  await db.connect()
  try {
    await applyMigrations(db)
    for (const account of TEST_ACCOUNTS.slice(0, 2)) await db.query(`
      INSERT INTO users(id,provider,provider_subject,display_name,email,created_at,updated_at,onboarding_completed_at,bank_name,account_number,account_holder,bank_updated_at)
      VALUES($1,'test',$2,$3,$4,1,1,1,$5,$6,$7,1)
      ON CONFLICT (provider,provider_subject) DO UPDATE SET deleted_at=NULL,onboarding_completed_at=1,
        bank_name=EXCLUDED.bank_name,account_number=EXCLUDED.account_number,account_holder=EXCLUDED.account_holder
    `, [account.id, account.providerSubject, account.displayName, account.email, account.bankName, account.accountNumber, account.accountHolder])
  } finally { await db.end() }

  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const secret = 'isolated-realtime-test-secret-at-least-32-bytes'
  const app = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', DATABASE_URL: database, AUTH_JWT_SECRET: secret, DB_QUERY_LOG: 'true' },
  })
  let output = ''
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 30000)
    app.stdout.on('data', bytes => { output += bytes; if (output.includes('Ready on port')) { clearTimeout(timeout); resolve() } })
    app.stderr.on('data', bytes => { output += bytes })
    app.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)) })
  })
  const connections = []
  try {
    await ready
    for (const path of ['/api/groups', '/api/me', '/api/me/onboarding', '/api/me/bank-account', '/api/rounds/id', '/api/invites/token', '/api/auth/withdraw', '/api/docs', '/api/openapi.json', '/api/unknown', '/api/health-extra', '/api/health/live/extra']) {
      const denied = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' }, body: '{invalid json' })
      assert.equal(denied.status, 401, `${path} must reject before parsing the body`)
      assert.equal((await denied.json()).error, 'unauthorized')
      assert.equal(denied.headers.get('Cache-Control'), 'private, no-store')
    }
    const now = currentTimestamp()
    for (const token of ['invalid', createAccessToken('user', 'session', secret, now - 10, 1), createAccessToken('user', 'session', 'wrong-secret-at-least-32-bytes-0000'), createRefreshToken('user', 'session', secret)]) {
      const denied = await fetch(`${origin}/api/groups`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}` }, body: '{invalid json' })
      assert.equal(denied.status, 401)
    }
    for (const path of ['', '/live', '/database', '/minio', '/dependencies']) {
      const health = await fetch(`${origin}/api/health${path}`)
      assert.equal(health.status, 200, `Public health ${path}`)
      assert.equal((await health.json()).status, 'ok')
    }
    assert.equal((await fetch(`${origin}/api/health/live`, { method: 'HEAD' })).status, 200)
    const invalidRefresh = await fetch(`${origin}/api/auth/refresh`, { method: 'POST', headers: { origin } })
    assert.equal(invalidRefresh.status, 401)
    assert.equal(invalidRefresh.headers.getSetCookie().length, 2)
    const home = await fetch(`${origin}/home`)
    assert.equal(home.status, 200, 'Home must compile in Turbopack development mode without server-only imports')
    async function connect(key) {
      const login = await fetch(`${origin}/api/auth/test-login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${key}` })
      assert.equal(login.status, 303)
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const bootstrap = await fetch(`${origin}/api/auth/access-token`, { method: 'POST', headers: { origin, cookie } })
      assert.equal(bootstrap.status, 200)
      const accessToken = (await bootstrap.json()).data.accessToken
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`, ['da-moa', accessToken], { headers: { Origin: origin } })
      connections.push(socket)
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      return { socket, cookie, accessToken }
    }
    async function rejectSocket(token) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`, ['da-moa', token], { headers: { Origin: origin } })
      connections.push(socket)
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Rejected connection timed out')) }, 5000)
        socket.once('open', () => { clearTimeout(timeout); reject(new Error('Invalid authentication was accepted')) })
        socket.once('error', () => { clearTimeout(timeout); resolve() })
      })
    }
    const memberId = TEST_ACCOUNTS[1].id
    for (const token of [
      'invalid', createAccessToken(memberId, 'session', secret, now - 10, 1),
      createAccessToken(memberId, 'session', 'wrong-secret-at-least-32-bytes-0000'),
      createRefreshToken(memberId, 'session', secret),
      createAccessToken(memberId, 'session', secret, now, 600, 'onboarding'),
      createAccessToken(randomUUID(), 'session', secret),
    ]) await rejectSocket(token)
    const stateDb = createDatabaseClient(database)
    await stateDb.connect()
    try {
      await stateDb.query('UPDATE users SET onboarding_completed_at=NULL WHERE id=$1', [memberId])
      await rejectSocket(createAccessToken(memberId, 'session', secret))
      await stateDb.query('UPDATE users SET onboarding_completed_at=1, deleted_at=1 WHERE id=$1', [memberId])
      await rejectSocket(createAccessToken(memberId, 'session', secret))
    } finally {
      await stateDb.query('UPDATE users SET onboarding_completed_at=1, deleted_at=NULL WHERE id=$1', [memberId])
      await stateDb.end()
    }
    const mine = await connect('member-a')
    const other = await connect('member-b')
    const authenticatedInvalid = await fetch(`${origin}/api/groups`, { method: 'POST', headers: { origin, authorization: `Bearer ${mine.accessToken}` }, body: '{invalid json' })
    assert.equal(authenticatedInvalid.status, 400, 'A valid JWT reaches body validation')
    assert.equal((await fetch(`${origin}/api/openapi.json`, { headers: { authorization: `Bearer ${mine.accessToken}` } })).status, 200)
    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/realtime`, { headers: { Origin: origin } })
    await new Promise((resolve, reject) => {
      anonymous.once('open', () => reject(new Error('Anonymous connection was accepted')))
      anonymous.once('error', resolve)
      anonymous.once('unexpected-response', resolve)
    })
    const foreignOrigin = new WebSocket(`ws://127.0.0.1:${port}/realtime`, ['da-moa', mine.accessToken], { headers: { Origin: 'https://other.example' } })
    await new Promise((resolve, reject) => {
      foreignOrigin.once('open', () => reject(new Error('Foreign Origin was accepted')))
      foreignOrigin.once('error', resolve)
      foreignOrigin.once('unexpected-response', resolve)
    })
    let leaked = false
    other.socket.on('message', () => { leaked = true })
    const message = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Invalidation timed out')), 10000)
      mine.socket.once('message', bytes => {
        clearTimeout(timeout)
        try { resolve(JSON.parse(bytes.toString())) } catch (error) { reject(error) }
      })
    })
    const response = await fetch(`${origin}/api/groups`, { method: 'POST', headers: { origin, authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json', 'idempotency-key': uuidV7() }, body: JSON.stringify({ name: `WebSocket ${randomUUID()}` }) })
    assert.equal(response.status, 200)
    const groupId = (await response.json()).data.id
    const event = await message
    assert.equal(event.type, 'invalidate')
    assert.ok(event.keys.includes('groups'))
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(leaked, false)
    const inviteMessage = once(mine.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const inviteResponse = await fetch(`${origin}/api/groups/${groupId}/invites`, { method: 'POST', headers: { origin, authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
    assert.equal(inviteResponse.status, 200)
    const invite = (await inviteResponse.json()).data
    const [inviteBytes] = await inviteMessage
    assert.deepEqual(JSON.parse(inviteBytes.toString()), { type: 'invalidate', keys: [`group:${groupId}`] })
    const detailResponse = await fetch(`${origin}/api/groups/${groupId}`, { headers: { authorization: `Bearer ${mine.accessToken}` } })
    assert.equal(detailResponse.status, 200)
    assert.deepEqual((await detailResponse.json()).data.invites.map(item => item.id), [invite.id], 'invite list reload sees the saved invitation after invalidation')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(leaked, false, 'invite invalidation is sent only to the creator')
    const revokeMessage = once(mine.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const revokeResponse = await fetch(`${origin}/api/groups/${groupId}/invites/${invite.id}`, { method: 'DELETE', headers: { origin, authorization: `Bearer ${mine.accessToken}`, 'idempotency-key': randomUUID() } })
    assert.equal(revokeResponse.status, 200)
    const [revokeBytes] = await revokeMessage
    assert.deepEqual(JSON.parse(revokeBytes.toString()), { type: 'invalidate', keys: [`group:${groupId}`] })
    const revokedDetail = await fetch(`${origin}/api/groups/${groupId}`, { headers: { authorization: `Bearer ${mine.accessToken}` } })
    assert.deepEqual((await revokedDetail.json()).data.invites, [])
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(leaked, false, 'invite revocation invalidation is sent only to the creator')
    const newInvite = await fetch(`${origin}/api/groups/${groupId}/invites`, { method: 'POST', headers: { origin, authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
    const acceptPath = (await newInvite.json()).data.sharePath
    await new Promise(resolve => setTimeout(resolve, 250))
    const creatorAcceptance = once(mine.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const memberAcceptance = once(other.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const acceptOutput = output.length
    const acceptResponse = await fetch(`${origin}/api${acceptPath}/accept`, { method: 'POST', headers: { origin, authorization: `Bearer ${other.accessToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
    assert.equal(acceptResponse.status, 200)
    for (const received of await Promise.all([creatorAcceptance, memberAcceptance])) {
      assert.deepEqual(JSON.parse(received[0].toString()), { type: 'invalidate', keys: ['groups', `group:${groupId}`] })
    }
    assert.equal((output.slice(acceptOutput).match(/SQL:/g) ?? []).length, 5, 'accept uses five SQL calls, including session lock release and publication')
    assert.doesNotMatch(output.slice(acceptOutput), /BEGIN|COMMIT|ROLLBACK|pg_advisory_xact_lock|FOR UPDATE|FOR SHARE/)
    assert.match(output.slice(acceptOutput), /pg_advisory_lock/)
    assert.match(output.slice(acceptOutput), /pg_advisory_unlock/)
    assert.doesNotMatch(output, /GET \/api\/me /, 'WebSocket authentication must not issue internal HTTP me requests')
    const ticket = uuidV7(), roundBody = { name: 'UUIDv7 회차', participantIds: TEST_ACCOUNTS.slice(0, 2).map(account => account.id) }
    const roundHeaders = { origin, authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json', 'idempotency-key': ticket }
    const roundMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const roundOutput = output.length
    const createdRound = await fetch(`${origin}/api/groups/${groupId}/rounds`, { method: 'POST', headers: roundHeaders, body: JSON.stringify(roundBody) })
    assert.equal(createdRound.status, 200)
    assert.deepEqual((await createdRound.json()).data, { id: ticket, roundId: ticket, status: 'RECORDING', version: 1 })
    for (const [bytes] of await Promise.all(roundMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${ticket}`, `settlement:${ticket}`],
    })
    assert.equal((output.slice(roundOutput).match(/SQL:/g) ?? []).length, 4, 'creation and WebSocket publication use lock + AUTH + INSERT + unlock')
    assert.doesNotMatch(output.slice(roundOutput), /BEGIN|COMMIT|ROLLBACK|pg_advisory_xact_lock|FOR UPDATE|FOR SHARE|mutation_requests/)
    assert.match(output.slice(roundOutput), /pg_advisory_lock/)
    assert.match(output.slice(roundOutput), /pg_advisory_unlock/)
    const duplicate = await fetch(`${origin}/api/groups/${groupId}/rounds`, { method: 'POST', headers: roundHeaders, body: JSON.stringify(roundBody) })
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).error, 'round_already_exists')
    const cancelOutput = output.length, cancelKey = randomUUID()
    const cancelHeaders = { ...roundHeaders, 'idempotency-key': cancelKey }, cancelBody = JSON.stringify({ expectedVersion: 1 })
    const cancelled = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    assert.equal((await fetch(`${origin}/api/rounds/${ticket}`, { method: 'DELETE', headers: cancelHeaders, body: cancelBody })).status, 200)
    for (const [bytes] of await Promise.all(cancelled)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${ticket}`, `settlement:${ticket}`],
    })
    assert.equal((output.slice(cancelOutput).match(/SQL:/g) ?? []).length, 6, 'cancel and WebSocket publication use BEGIN + AUTH + lock + check + delete/save + COMMIT')
    const cancellationSql = output.slice(cancelOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.match(cancellationSql[0], /^BEGIN/)
    assert.match(cancellationSql[1], /FROM\s+users/)
    assert.match(cancellationSql[2], /pg_advisory_xact_lock/)
    assert.match(cancellationSql[3], /expenses/)
    assert.match(cancellationSql[4], /DELETE FROM\s+rounds/)
    assert.match(cancellationSql[5], /^COMMIT/)
    const replayOutput = output.length
    assert.equal((await fetch(`${origin}/api/rounds/${ticket}`, { method: 'DELETE', headers: cancelHeaders, body: cancelBody })).status, 200)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal((output.slice(replayOutput).match(/SQL:/g) ?? []).length, 5, 'cancel replay uses the saved result without post-delete audience reads')
    const expenseRoundId = uuidV7()
    const expenseRoundMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    assert.equal((await fetch(`${origin}/api/groups/${groupId}/rounds`, { method: 'POST', headers: { ...roundHeaders, 'idempotency-key': expenseRoundId }, body: JSON.stringify(roundBody) })).status, 200)
    await Promise.all(expenseRoundMessages)
    const expenseHeaders = { ...roundHeaders, 'idempotency-key': randomUUID() }
    const expenseBody = JSON.stringify({ currency: 'KRW', description: '지출 SQL 검증', amount: '100', payerId: memberId, splitMode: 'ALL', expectedVersion: 1 })
    const expenseMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const expenseOutput = output.length
    const expenseResponse = await fetch(`${origin}/api/rounds/${expenseRoundId}/expenses`, { method: 'POST', headers: expenseHeaders, body: expenseBody })
    assert.equal(expenseResponse.status, 200, await expenseResponse.clone().text())
    const savedExpense = (await expenseResponse.json()).data
    for (const [bytes] of await Promise.all(expenseMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${expenseRoundId}`, `settlement:${expenseRoundId}`],
    })
    const expenseSql = output.slice(expenseOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(expenseSql.length, 6, 'expense creation and WebSocket publication do not add audience reads')
    assert.match(expenseSql[0], /FROM\s+users/)
    assert.match(expenseSql[1], /^BEGIN/)
    assert.match(expenseSql[2], /pg_advisory_xact_lock/)
    assert.match(expenseSql[3], /INSERT INTO\s+expenses/)
    assert.match(expenseSql[4], /INSERT INTO\s+expense_shares/)
    assert.match(expenseSql[5], /^COMMIT/)
    const expenseReplayOutput = output.length
    const expenseReplay = await fetch(`${origin}/api/rounds/${expenseRoundId}/expenses`, { method: 'POST', headers: expenseHeaders, body: expenseBody })
    assert.deepEqual((await expenseReplay.json()).data, savedExpense)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal((output.slice(expenseReplayOutput).match(/SQL:/g) ?? []).length, 5)
    const receiptTicket = randomUUID()
    const receiptHeaders = { origin, authorization: `Bearer ${mine.accessToken}`, 'idempotency-key': receiptTicket }
    const receiptForm = new FormData()
    const avif = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).avif().toBuffer()
    receiptForm.set('file', new File([avif], 'receipt.AVIF', { type: 'image/avif' }))
    receiptForm.set('expectedVersion', String(savedExpense.version))
    const receiptPath = `${origin}/api/rounds/${expenseRoundId}/expenses/${savedExpense.id}/receipts`
    const receiptMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const receiptOutput = output.length
    const receiptResponse = await fetch(receiptPath, { method: 'POST', headers: receiptHeaders, body: receiptForm })
    assert.equal(receiptResponse.status, 200, await receiptResponse.clone().text())
    const savedReceipt = (await receiptResponse.json()).data
    for (const [bytes] of await Promise.all(receiptMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${expenseRoundId}`, `settlement:${expenseRoundId}`],
    })
    const receiptSql = output.slice(receiptOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(receiptSql.length, 2, 'receipt upload including WebSocket publication uses two SQL calls')
    assert.match(receiptSql[0], /FROM\s+users/)
    assert.match(receiptSql[1], /UPDATE\s+rounds[\s\S]*INSERT INTO\s+expense_receipts[\s\S]*INSERT INTO\s+mutation_requests/)
    assert.ok(receiptSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
    const receiptReadOutput = output.length
    const receiptImage = await fetch(`${origin}/api/receipts/${savedReceipt.id}`, { headers: { authorization: `Bearer ${other.accessToken}` } })
    assert.equal(receiptImage.status, 200)
    assert.equal(receiptImage.headers.get('content-type'), 'image/avif')
    assert.equal(receiptImage.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(receiptImage.headers.get('cache-control'), 'private, no-store')
    assert.equal((await sharp(Buffer.from(await receiptImage.arrayBuffer())).metadata()).compression, 'av1')
    const receiptReadSql = output.slice(receiptReadOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(receiptReadSql.length, 2, 'receipt GET uses account lookup and a single authorized storage lookup')
    assert.match(receiptReadSql[0], /FROM\s+users/)
    assert.match(receiptReadSql[1], /FROM\s+expense_receipts[\s\S]*JOIN\s+expenses[\s\S]*JOIN\s+rounds[\s\S]*JOIN\s+round_members/)
    assert.ok(receiptReadSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
    let receiptReplayPublished = false
    const onReceiptReplay = () => { receiptReplayPublished = true }
    mine.socket.on('message', onReceiptReplay)
    other.socket.on('message', onReceiptReplay)
    try {
      const replayOutput = output.length
      const replay = await fetch(receiptPath, { method: 'POST', headers: receiptHeaders, body: receiptForm })
      assert.equal(replay.status, 200)
      assert.deepEqual((await replay.json()).data, savedReceipt)
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(receiptReplayPublished, false)
      assert.equal((output.slice(replayOutput).match(/SQL:/g) ?? []).length, 2)
    } finally {
      mine.socket.off('message', onReceiptReplay)
      other.socket.off('message', onReceiptReplay)
    }
    const authOutput = output.length
    const inactiveUpload = await fetch(receiptPath, { method: 'POST', headers: { origin, authorization: `Bearer ${createAccessToken(randomUUID(), 'session', secret)}` }, body: '{invalid form' })
    assert.equal(inactiveUpload.status, 401, 'account lookup precedes multipart validation')
    assert.equal((output.slice(authOutput).match(/SQL:/g) ?? []).length, 1)
    const receiptDeleteTicket = randomUUID()
    const receiptDeleteHeaders = { ...expenseHeaders, 'idempotency-key': receiptDeleteTicket }
    const receiptDeleteBody = JSON.stringify({ expectedVersion: savedReceipt.version })
    const receiptDeleteMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const receiptDeleteOutput = output.length
    const receiptDeletedResponse = await fetch(`${receiptPath}/${savedReceipt.id}`, { method: 'DELETE', headers: receiptDeleteHeaders, body: receiptDeleteBody })
    assert.equal(receiptDeletedResponse.status, 200, await receiptDeletedResponse.clone().text())
    const deletedReceipt = (await receiptDeletedResponse.json()).data
    for (const [bytes] of await Promise.all(receiptDeleteMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${expenseRoundId}`, `settlement:${expenseRoundId}`],
    })
    const receiptDeleteSql = output.slice(receiptDeleteOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(receiptDeleteSql.length, 3, 'receipt deletion including WebSocket publication uses three SQL calls')
    assert.match(receiptDeleteSql[0], /FROM\s+users/)
    assert.match(receiptDeleteSql[1], /LEFT JOIN\s+expense_receipts[\s\S]*operation\s*=\s*'receipt.delete'/)
    assert.match(receiptDeleteSql[2], /UPDATE\s+rounds[\s\S]*DELETE FROM\s+expense_receipts[\s\S]*INSERT INTO\s+mutation_requests/)
    assert.ok(receiptDeleteSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
    let deleteReplayPublished = false
    const onDeleteReplay = () => { deleteReplayPublished = true }
    mine.socket.on('message', onDeleteReplay)
    other.socket.on('message', onDeleteReplay)
    try {
      const replayOutput = output.length
      const replay = await fetch(`${receiptPath}/${savedReceipt.id}`, { method: 'DELETE', headers: receiptDeleteHeaders, body: receiptDeleteBody })
      assert.equal(replay.status, 200)
      assert.deepEqual((await replay.json()).data, deletedReceipt)
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(deleteReplayPublished, false)
      assert.equal((output.slice(replayOutput).match(/SQL:/g) ?? []).length, 2)
    } finally {
      mine.socket.off('message', onDeleteReplay)
      other.socket.off('message', onDeleteReplay)
    }
    let expenseVersion = deletedReceipt.version
    const confirmHeaders = { ...roundHeaders, 'idempotency-key': randomUUID() }
    const confirmBody = JSON.stringify({ expectedVersion: expenseVersion })
    const confirmMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const confirmOutput = output.length
    const confirmResponse = await fetch(`${origin}/api/rounds/${expenseRoundId}/confirm`, { method: 'POST', headers: confirmHeaders, body: confirmBody })
    assert.equal(confirmResponse.status, 200)
    const confirmed = (await confirmResponse.json()).data
    for (const [bytes] of await Promise.all(confirmMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${expenseRoundId}`, `settlement:${expenseRoundId}`],
    })
    const confirmSql = output.slice(confirmOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(confirmSql.length, 6, 'confirmation and WebSocket publication use exactly six SQL calls')
    assert.match(confirmSql[0], /FROM\s+users/)
    assert.match(confirmSql[1], /^BEGIN/)
    assert.match(confirmSql[2], /operation = 'round.confirm'/)
    assert.match(confirmSql[3], /pg_advisory_xact_lock/)
    assert.match(confirmSql[4], /UPDATE\s+rounds[\s\S]*UPDATE\s+expenses[\s\S]*INSERT INTO\s+mutation_requests/)
    assert.match(confirmSql[5], /^COMMIT/)
    const confirmReplayOutput = output.length
    let replayInvalidation = false
    const onReplay = () => { replayInvalidation = true }
    mine.socket.on('message', onReplay)
    try {
      const replay = await fetch(`${origin}/api/rounds/${expenseRoundId}/confirm`, { method: 'POST', headers: confirmHeaders, body: confirmBody })
      assert.deepEqual((await replay.json()).data, confirmed)
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(replayInvalidation, false, 'confirmation replay must not publish again')
      assert.equal((output.slice(confirmReplayOutput).match(/SQL:/g) ?? []).length, 5)
    } finally { mine.socket.off('message', onReplay) }
    const reopenMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const reopened = await fetch(`${origin}/api/rounds/${expenseRoundId}/reopen`, { method: 'POST', headers: { ...roundHeaders, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersion: confirmed.version }) })
    assert.equal(reopened.status, 200)
    expenseVersion = (await reopened.json()).data.version
    await Promise.all(reopenMessages)
    for (const path of [`rounds/${expenseRoundId}/expenses/${savedExpense.id}`, `rounds/${expenseRoundId}`]) {
      const cleanupMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
      const cleanup = await fetch(`${origin}/api/${path}`, { method: 'DELETE', headers: { ...roundHeaders, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersion: expenseVersion }) })
      assert.equal(cleanup.status, 200)
      expenseVersion = (await cleanup.json()).data.version
      await Promise.all(cleanupMessages)
    }
    const refreshCookie = mine.cookie.split('; ').find(value => value.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
    const drawRoundId = uuidV7()
    const roundPost = async (path, body, ticket = randomUUID(), actor = mine) => {
      const notifications = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
      const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers: { ...roundHeaders, authorization: `Bearer ${actor.accessToken}`, 'idempotency-key': ticket }, body: JSON.stringify(body) })
      assert.equal(response.status, 200, await response.clone().text())
      const events = await Promise.all(notifications)
      if (path.endsWith('/settlement-check')) for (const [bytes] of events) {
        assert.deepEqual(JSON.parse(bytes.toString()).keys, [`settlement:${path.split('/')[1]}`])
      }
      return (await response.json()).data
    }
    await roundPost(`groups/${groupId}/rounds`, roundBody, drawRoundId)
    const drawExpense = await roundPost(`rounds/${drawRoundId}/expenses`, { currency: 'KRW', description: '추첨 SQL 검증', amount: '3', payerId: memberId, splitMode: 'ALL', expectedVersion: 1 })
    const drawConfirmed = await roundPost(`rounds/${drawRoundId}/confirm`, { expectedVersion: drawExpense.version })
    const drawLocked = await roundPost(`rounds/${drawRoundId}/send`, { expectedVersion: drawConfirmed.version })
    const drawOutput = output.length
    const drawResult = await roundPost(`rounds/${drawRoundId}/draw`, { expectedVersion: drawLocked.version })
    const drawSql = output.slice(drawOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(drawSql.length, 3, 'draw including WebSocket publication uses exactly three SQL calls')
    assert.match(drawSql[0], /FROM\s+users/)
    assert.match(drawSql[1], /operation = 'round.draw'/)
    assert.match(drawSql[2], /FOR UPDATE OF\s+r[\s\S]*INSERT INTO\s+mutation_requests[\s\S]*UPDATE\s+rounds[\s\S]*UPDATE\s+expense_shares[\s\S]*INSERT INTO\s+settlement_balances[\s\S]*INSERT INTO\s+settlement_transfers/)
    const receiverAccount = await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${other.accessToken}` } }).then(response => response.json())
    try {
      const bankNotifications = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
      const bankOutput = output.length
      const bankResponse = await fetch(`${origin}/api/me/bank-account`, {
        method: 'PUT', headers: { ...roundHeaders, authorization: `Bearer ${other.accessToken}` },
        body: JSON.stringify({ bankCode: '004', accountNumber: '12340312345678', accountHolder: TEST_ACCOUNTS[1].displayName, expectedBankVersion: receiverAccount.data.bankVersion }),
      })
      assert.equal(bankResponse.status, 200, await bankResponse.clone().text())
      const [[senderBankBytes], [ownerBankBytes]] = await Promise.all(bankNotifications)
      const senderBankKeys = JSON.parse(senderBankBytes.toString()).keys
      assert.ok(senderBankKeys.includes(`settlement:${drawRoundId}`))
      assert.ok(senderBankKeys.every(key => /^settlement:[0-9a-f-]{36}$/.test(key)))
      assert.deepEqual(JSON.parse(ownerBankBytes.toString()).keys, ['me'])
      const bankSql = output.slice(bankOutput).split('SQL:').slice(1).map(sql => sql.trim())
      assert.equal(bankSql.length, 3, 'bank update uses AUTH + UPDATE + one audience SELECT')
      assert.ok(bankSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)))
    } finally {
      const restoreDb = createDatabaseClient(database)
      await restoreDb.connect()
      try {
        const account = receiverAccount.data.bankAccount
        await restoreDb.query(`UPDATE users SET bank_code=$2,bank_name=$3,account_number=$4,account_number_formatted=$5,
          account_holder=$6,bank_verified_at=$7,bank_version=$8 WHERE id=$1`,
          [memberId, account.bankCode, account.bankName, account.accountNumber, account.formattedAccountNumber, account.accountHolder, account.verifiedAt, receiverAccount.data.bankVersion])
      } finally { await restoreDb.end() }
    }
    const checkBody = { expectedVersion: drawResult.version, checked: true, currency: 'KRW', senderId: TEST_ACCOUNTS[0].id }
    const checkTicket = randomUUID(), checkOutput = output.length
    const checkResult = await roundPost(`rounds/${drawRoundId}/settlement-check`, checkBody, checkTicket, other)
    assert.equal(checkResult.version, drawResult.version)
    const checkSql = output.slice(checkOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(checkSql.length, 3, 'settlement check including WebSocket publication uses exactly three SQL calls')
    assert.match(checkSql[0], /FROM\s+users/)
    assert.match(checkSql[1], /AS incoming[\s\S]*AS user_ids/)
    assert.match(checkSql[2], /UPDATE\s+settlement_transfers[\s\S]*receiver_id = \$2/)
    assert.ok(checkSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/.test(sql)))
    let repeatedCheckInvalidation = false
    const onRepeatedCheck = () => { repeatedCheckInvalidation = true }
    mine.socket.on('message', onRepeatedCheck)
    try {
      const repeatedCheckOutput = output.length
      const repeated = await fetch(`${origin}/api/rounds/${drawRoundId}/settlement-check`, {
        method: 'POST', headers: { ...roundHeaders, authorization: `Bearer ${other.accessToken}`, 'idempotency-key': checkTicket }, body: JSON.stringify(checkBody),
      })
      assert.equal(repeated.status, 404)
      assert.equal((await repeated.json()).error, 'not_found')
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(repeatedCheckInvalidation, false, 'unchanged receipt must not publish')
      assert.equal((output.slice(repeatedCheckOutput).match(/SQL:/g) ?? []).length, 2)
    } finally { mine.socket.off('message', onRepeatedCheck) }
    await roundPost(`rounds/${drawRoundId}/settlement-check`, { ...checkBody, checked: false }, randomUUID(), other)
    const forceBody = { expectedVersion: drawResult.version }, forceTicket = randomUUID(), forceOutput = output.length
    const forced = await roundPost(`rounds/${drawRoundId}/force-complete`, forceBody, forceTicket)
    const forceSql = output.slice(forceOutput).split('SQL:').slice(1).map(sql => sql.trim())
    assert.equal(forceSql.length, 3, 'force completion including WebSocket publication uses exactly three SQL calls')
    assert.match(forceSql[0], /FROM\s+users/)
    assert.match(forceSql[1], /DISTINCT\s+receiver_id[\s\S]*AS pending_user_ids[\s\S]*AS user_ids/)
    assert.match(forceSql[2], /UPDATE\s+rounds[\s\S]*INSERT INTO\s+mutation_requests/)
    assert.ok(forceSql.every(sql => !/\b(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
    let forceReplayInvalidation = false
    const onForceReplay = () => { forceReplayInvalidation = true }
    mine.socket.on('message', onForceReplay)
    try {
      const replayOutput = output.length
      const replay = await fetch(`${origin}/api/rounds/${drawRoundId}/force-complete`, {
        method: 'POST', headers: { ...roundHeaders, 'idempotency-key': forceTicket }, body: JSON.stringify(forceBody),
      })
      assert.equal(replay.status, 200)
      assert.deepEqual((await replay.json()).data, forced)
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(forceReplayInvalidation, false, 'force completion replay must not publish')
      assert.equal((output.slice(replayOutput).match(/SQL:/g) ?? []).length, 2)
    } finally { mine.socket.off('message', onForceReplay) }
    const refreshed = await fetch(`${origin}/api/auth/refresh`, { method: 'POST', headers: { origin, cookie: refreshCookie } })
    assert.equal(refreshed.status, 200, 'Refresh JWT works without an Access JWT')
    assert.equal((await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${mine.accessToken}` } })).status, 200, 'Refresh rotation does not revoke an unexpired Access JWT')
    const newAccessToken = (await refreshed.json()).data.accessToken
    const newCookie = refreshed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.equal((await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${newAccessToken}` } })).status, 200)
    const newRefreshCookie = newCookie.split('; ').find(value => value.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
    assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { origin, cookie: newRefreshCookie } })).status, 200)
    assert.equal((await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${newAccessToken}` } })).status, 200, 'Logout deletes client tokens without revoking Access JWTs')
    const departure = once(mine.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const withdrawn = await fetch(`${origin}/api/auth/withdraw`, { method: 'POST', headers: { origin, authorization: `Bearer ${other.accessToken}` } })
    assert.equal(withdrawn.status, 200)
    assert.deepEqual(await withdrawn.json(), { ok: true })
    assert.equal(withdrawn.headers.get('Cache-Control'), 'private, no-store')
    assert.ok(withdrawn.headers.getSetCookie().some(value => value.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
    const [departureBytes] = await departure
    const departureEvent = JSON.parse(departureBytes.toString())
    assert.deepEqual(departureEvent, { type: 'invalidate', keys: departureEvent.keys })
    assert.ok(departureEvent.keys.includes('groups') && departureEvent.keys.includes(`group:${groupId}`))
    assert.ok(departureEvent.keys.every(value => value === 'groups' || /^group:[0-9a-f-]{36}$/.test(value)))
    assert.equal((await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${other.accessToken}` } })).status, 401, 'soft deletion rejects the withdrawn member\'s existing JWT')
  } finally {
    for (const socket of connections) socket.terminate()
    app.kill('SIGTERM')
  }
})
