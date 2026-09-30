import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/api/health/[[...check]]/route'
import { checkMinio, healthResponse } from './health'

test('liveness skips dependencies and overall health reports each failure', async () => {
  let databaseChecks = 0
  let minioUp = false
  const probes = {
    database: async () => { databaseChecks++ },
    minio: async () => { if (!minioUp) throw new Error('secret connection detail') },
  }

  const live = await healthResponse('live', probes)
  assert.equal(live.status, 200)
  assert.deepEqual(await live.json(), { status: 'ok', checks: { application: 'ok' } })
  assert.equal(databaseChecks, 0)

  const dependencies = await healthResponse('dependencies', probes)
  assert.equal(dependencies.status, 503)
  assert.deepEqual(await dependencies.json(), { status: 'down', checks: { database: 'ok', minio: 'down' } })

  const database = await healthResponse('database', probes)
  assert.equal(database.status, 200)
  assert.deepEqual(await database.json(), { status: 'ok', checks: { database: 'ok' } })
  const minio = await healthResponse('minio', probes)
  assert.equal(minio.status, 503)
  assert.deepEqual(await minio.json(), { status: 'down', checks: { minio: 'down' } })
  assert.equal(databaseChecks, 2)

  minioUp = true
  const overall = await healthResponse('overall', probes)
  assert.equal(overall.status, 200)
  assert.deepEqual(await overall.json(), { status: 'ok', checks: { application: 'ok', database: 'ok', minio: 'ok' } })
  assert.equal(overall.headers.get('Cache-Control'), 'no-store')
})

test('health routes require MinIO read and write quorum', async () => {
  const live = await GET(new Request('http://localhost/api/health/live'), { params: Promise.resolve({ check: ['live'] }) })
  assert.equal(live.status, 200)
  const unknown = await GET(new Request('http://localhost/api/health/unknown'), { params: Promise.resolve({ check: ['unknown'] }) })
  assert.equal(unknown.status, 404)

  const originalEndpoint = process.env.MINIO_ENDPOINT
  const originalFetch = globalThis.fetch
  process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000'
  try {
    const paths: string[] = []
    globalThis.fetch = async (input, init) => {
      paths.push(String(input))
      assert.equal(init?.cache, 'no-store')
      return new Response(null, { status: 200 })
    }
    await checkMinio()
    assert.deepEqual(paths.sort(), ['http://127.0.0.1:9000/minio/health/cluster', 'http://127.0.0.1:9000/minio/health/cluster/read'])
    const minio = await GET(new Request('http://localhost/api/health/minio'), { params: Promise.resolve({ check: ['minio'] }) })
    assert.deepEqual(await minio.json(), { status: 'ok', checks: { minio: 'ok' } })
    for (const failedPath of paths) {
      globalThis.fetch = async input => new Response(null, { status: String(input) === failedPath ? 503 : 200 })
      await assert.rejects(checkMinio, /not ready/)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalEndpoint === undefined) delete process.env.MINIO_ENDPOINT
    else process.env.MINIO_ENDPOINT = originalEndpoint
  }
})
