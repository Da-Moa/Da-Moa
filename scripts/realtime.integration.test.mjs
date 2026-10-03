import { uuidV7 } from '../src/lib/uuid.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
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
    assert.deepEqual(JSON.parse(inviteBytes.toString()), { type: 'invalidate', keys: ['groups', `group:${groupId}`] })
    const detailResponse = await fetch(`${origin}/api/groups/${groupId}`, { headers: { authorization: `Bearer ${mine.accessToken}` } })
    assert.equal(detailResponse.status, 200)
    assert.deepEqual((await detailResponse.json()).data.invites.map(item => item.id), [invite.id], 'invite list reload sees the saved invitation after invalidation')
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(leaked, false, 'invite invalidation is sent only to the creator')
    const revokeMessage = once(mine.socket, 'message', { signal: AbortSignal.timeout(10000) })
    const revokeResponse = await fetch(`${origin}/api/groups/${groupId}/invites/${invite.id}`, { method: 'DELETE', headers: { origin, authorization: `Bearer ${mine.accessToken}`, 'idempotency-key': randomUUID() } })
    assert.equal(revokeResponse.status, 200)
    const [revokeBytes] = await revokeMessage
    assert.deepEqual(JSON.parse(revokeBytes.toString()), { type: 'invalidate', keys: ['groups', `group:${groupId}`] })
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
    const roundBody = { name: '락으로 생성한 회차', currency: 'KRW', participantIds: TEST_ACCOUNTS.slice(0, 2).map(account => account.id) }
    const roundHeaders = { origin, authorization: `Bearer ${mine.accessToken}`, 'content-type': 'application/json' }
    const roundMessages = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    const roundOutput = output.length
    const createdRound = await fetch(`${origin}/api/groups/${groupId}/rounds`, { method: 'POST', headers: roundHeaders, body: JSON.stringify(roundBody) })
    assert.equal(createdRound.status, 200)
    const round = (await createdRound.json()).data
    assert.match(round.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.deepEqual(round, { id: round.id, roundId: round.id, status: 'RECORDING', version: 1 })
    for (const [bytes] of await Promise.all(roundMessages)) assert.deepEqual(JSON.parse(bytes.toString()), {
      type: 'invalidate', keys: ['rounds', `group-rounds:${groupId}`, `round:${round.id}`, `settlement:${round.id}`],
    })
    assert.equal((output.slice(roundOutput).match(/SQL:/g) ?? []).length, 4, 'creation and WebSocket publication use lock + AUTH + INSERT + unlock')
    assert.doesNotMatch(output.slice(roundOutput), /BEGIN|COMMIT|ROLLBACK|pg_advisory_xact_lock|FOR UPDATE|FOR SHARE|mutation_requests/)
    assert.match(output.slice(roundOutput), /pg_advisory_lock/)
    assert.match(output.slice(roundOutput), /pg_advisory_unlock/)
    const cancelled = [mine, other].map(person => once(person.socket, 'message', { signal: AbortSignal.timeout(10000) }))
    assert.equal((await fetch(`${origin}/api/rounds/${round.id}`, { method: 'DELETE', headers: { ...roundHeaders, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersion: 1 }) })).status, 200)
    await Promise.all(cancelled)
    const refreshCookie = mine.cookie.split('; ').find(value => value.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
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
