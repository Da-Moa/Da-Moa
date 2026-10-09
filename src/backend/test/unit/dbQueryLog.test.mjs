import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from 'pg'
import { createDatabaseClient } from '../../global/database/dbClient.mjs'

test('SQL 로그가 쿼리 동작을 유지하고 파라미터·응답 데이터를 노출하지 않는다', async t => {
  const previous = process.env.DB_QUERY_LOG
  t.after(() => {
    if (previous === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = previous
  })
  const logs = []
  t.mock.method(console, 'info', sql => logs.push(sql))
  const secret = 'private-account-token-value'
  const result = { rowCount: 1, rows: [{ account: secret }] }
  const promise = Promise.resolve(result)
  let execute = () => promise
  let receiver
  let argumentsSeen
  t.mock.method(Client.prototype, 'query', function (...args) {
    receiver = this
    argumentsSeen = args
    return execute(...args)
  })
  const client = createDatabaseClient('postgresql://test:private-password@localhost/query_log_test')
  const params = [secret]
  process.env.DB_QUERY_LOG = 'false'
  assert.equal(client.query('SELECT $1', params), promise)
  assert.deepEqual(logs, [])

  process.env.DB_QUERY_LOG = 'true'
  const config = { text: 'SELECT u.id,u.display_name FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL', values: params }
  assert.equal(client.query(config), promise)
  assert.equal(await promise, result)
  assert.equal(receiver, client)
  assert.deepEqual(argumentsSeen, [config])
  assert.equal(logs[0], 'SQL:\n    SELECT\n        u.id,\n        u.display_name\n    FROM\n        users u\n    WHERE\n        u.id = $1\n        AND u.deleted_at IS NULL')

  await client.query("SELECT 'FROM WHERE, JOIN SELECT' AS text, $1::text AS value", params)
  assert.match(logs.at(-1), /'FROM WHERE, JOIN SELECT'/)
  assert.match(logs.at(-1), /\$1/)

  const unsupported = "SELECT 'unterminated"
  assert.equal(client.query(unsupported), promise)
  assert.equal(logs.at(-1), `SQL:\n    ${unsupported}`)
  assert.deepEqual(argumentsSeen, [unsupported])

  const failure = Object.assign(new Error(secret), { code: '22P02', detail: secret })
  execute = () => Promise.reject(failure)
  await assert.rejects(client.query('SELECT $1::integer', params), error => error === failure)
  execute = () => { throw failure }
  assert.throws(() => client.query('SELECT $1', params), error => error === failure)

  const callback = () => {}
  execute = () => undefined
  assert.equal(client.query('SELECT $1', params, callback), undefined)
  assert.deepEqual(argumentsSeen, ['SELECT $1', params, callback])

  execute = () => promise
  const probe = createDatabaseClient('postgresql://test:test@localhost/query_log_test', { instrument: false })
  assert.equal(probe.query('SELECT 1'), promise)
  assert.equal(logs.at(-1), 'SQL:\n    SELECT\n        1', 'metric probes must also be logged')
  assert.equal(logs.length, 7)
  assert.doesNotMatch(logs.join('\n'), /private-account|private-password|postgresql:|"values"|"rows"|"detail"|db\.query\.(start|end)/)

  process.env.DB_QUERY_LOG = 'false'
  assert.equal(client.query('SELECT 1'), promise)
  assert.equal(logs.length, 7, 'logging can be disabled on existing clients')
})
