import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { createServer } from 'node:http'
import test from 'node:test'
import { GET } from '../src/app/api/health/[[...check]]/route.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl

test('individual health routes probe PostgreSQL and MinIO independently', async t => {
  let minioStatus = 200
  const paths: string[] = []
  const minio = createServer((request, response) => { paths.push(request.url!); response.writeHead(minioStatus).end() })
  await new Promise<void>(resolve => minio.listen(0, '127.0.0.1', resolve))
  const address = minio.address() as { port: number }
  process.env.MINIO_ENDPOINT = `http://127.0.0.1:${address.port}`
  const get = (check: string) => GET(new Request(`http://localhost/api/health/${check}`), { params: Promise.resolve({ check: [check] }) })
  try {
    minioStatus = 503
    const previousLog = process.env.DB_QUERY_LOG
    process.env.DB_QUERY_LOG = 'true'
    const sql: string[] = []
    let queryCount = 0
    const countQuery = () => { queryCount++ }
    channel('da-moa.db.query').subscribe(countQuery)
    const logger = t.mock.method(console, 'info', (message: string) => { sql.push(message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()) })
    let database: Response
    try { database = await get('database') }
    finally {
      channel('da-moa.db.query').unsubscribe(countQuery)
      logger.mock.restore()
      if (previousLog === undefined) delete process.env.DB_QUERY_LOG
      else process.env.DB_QUERY_LOG = previousLog
    }
    assert.equal(database.status, 200)
    assert.deepEqual(await database.json(), { status: 'ok', checks: { database: 'ok' } })
    assert.deepEqual(sql, ['SELECT 1'])
    assert.equal(queryCount, 1, 'DB health must count exactly one query in monitoring')
    assert.deepEqual(paths, [])
    const failedMinio = await get('minio')
    assert.equal(failedMinio.status, 503)
    assert.deepEqual(await failedMinio.json(), { status: 'down', checks: { minio: 'down' } })
    assert.deepEqual(paths.sort(), ['/minio/health/cluster', '/minio/health/cluster/read'])

    minioStatus = 200
    process.env.DATABASE_URL = ''
    process.env.POSTGRES_URL = ''
    const healthyMinio = await get('minio')
    assert.equal(healthyMinio.status, 200)
    assert.deepEqual(await healthyMinio.json(), { status: 'ok', checks: { minio: 'ok' } })
    const failedDatabase = await get('database')
    assert.equal(failedDatabase.status, 503)
    assert.deepEqual(await failedDatabase.json(), { status: 'down', checks: { database: 'down' } })
  } finally {
    await new Promise<void>(resolve => minio.close(() => resolve()))
  }
})
