import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import { createDatabaseClient } from '../src/lib/db.ts'
import { TEST_ACCOUNTS } from '../src/lib/test-accounts.ts'
import { applyMigrations } from './migrations.mjs'

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
  const app = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', DATABASE_URL: database, AUTH_JWT_SECRET: 'isolated-realtime-test-secret-at-least-32-bytes' },
  })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 30000)
    app.stdout.on('data', bytes => { output += bytes; if (output.includes('Ready on port')) { clearTimeout(timeout); resolve() } })
    app.stderr.on('data', bytes => { output += bytes })
    app.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)) })
  })
  const connections = []
  try {
    await ready
    const home = await fetch(`${origin}/home`)
    assert.equal(home.status, 200, 'Home must compile in Turbopack development mode without server-only imports')
    async function connect(key) {
      const login = await fetch(`${origin}/api/auth/test-login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${key}` })
      assert.equal(login.status, 303)
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`, { headers: { Origin: origin, Cookie: cookie } })
      connections.push(socket)
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      return { socket, cookie }
    }
    const mine = await connect('member-a')
    const other = await connect('member-b')
    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/realtime`, { headers: { Origin: origin } })
    await new Promise((resolve, reject) => {
      anonymous.once('open', () => reject(new Error('Anonymous connection was accepted')))
      anonymous.once('error', resolve)
      anonymous.once('unexpected-response', resolve)
    })
    const foreignOrigin = new WebSocket(`ws://127.0.0.1:${port}/realtime`, { headers: { Origin: 'https://other.example', Cookie: mine.cookie } })
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
    const response = await fetch(`${origin}/api/groups`, { method: 'POST', headers: { origin, cookie: mine.cookie, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ name: `WebSocket ${randomUUID()}` }) })
    assert.equal(response.status, 200)
    const event = await message
    assert.equal(event.type, 'invalidate')
    assert.ok(event.keys.includes('groups'))
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(leaked, false)
  } finally {
    for (const socket of connections) socket.terminate()
    app.kill('SIGTERM')
  }
})
