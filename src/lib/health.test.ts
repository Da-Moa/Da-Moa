import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/api/health/[[...check]]/route'
import { getHealthResponse } from '../Domain/Health/Backend/Controller/HealthController'
import { checkMinio } from '../Domain/Health/Backend/Repository/HealthRepository'
import type { HealthProbes } from '../Domain/Health/Backend/Service/HealthService'
import type { HealthScope } from '../Domain/Health/Shared/DTO/HealthDTO'
import { openApiDocument } from './openapi'

const healthResponse = (scope: HealthScope, checks: HealthProbes) => getHealthResponse(scope === 'overall' ? undefined : [scope], checks)

test('individual health checks only probe the selected dependency and report failures', async () => {
  for (const scope of ['database', 'minio'] as const) {
    for (const up of [true, false]) {
      const calls: string[] = []
      const probe = async (name: string) => { calls.push(name); if (!up) throw new Error('secret connection detail') }
      const probes = { database: () => probe('database'), minio: () => probe('minio') }
      const response = await healthResponse(scope, probes)
      assert.deepEqual(calls, [scope])
      assert.equal(response.status, up ? 200 : 503)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.deepEqual(await response.json(), { status: up ? 'ok' : 'down', checks: { [scope]: up ? 'ok' : 'down' } })
      const operation = openApiDocument.paths[`/api/health/${scope}`].get
      assert.ok(operation.responses['503'])
      const schema = operation.responses['200'].content['application/json'].schema as { properties: { checks: { required: string[] } } }
      assert.deepEqual(schema.properties.checks.required, [scope])
    }
  }
})

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
    assert.equal(minio.status, 200)
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
