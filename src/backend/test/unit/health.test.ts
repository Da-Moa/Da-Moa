import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { health as GET } from '../support/httpTestSupport';
import { HealthRepository } from '../../domain/health/repository/health.repository';
import {
  HEALTH_WORKER_PROBES,
  HealthService,
  type HealthWorkerProbes,
} from '../../domain/health/service/health.service';
import { createAccessToken } from '../support/legacyTokenTestSupport.ts';
import { PrismaService } from '../../global/database/prisma.service';
import { createBackend } from '../../domain/main';
import type { INestApplication } from '@nestjs/common';

type HealthScope =
  | 'overall'
  | 'live'
  | 'database'
  | 'minio'
  | 'dependencies'
  | 'worker'
  | 'worker/readyz';
type HealthProbes = HealthWorkerProbes & {
  database: () => Promise<unknown>;
  minio: () => Promise<unknown>;
};
import { openApiDocument } from '../../global/util/openapi';

let app: INestApplication;
let origin: string;
let probes: Partial<HealthProbes>;
const previousSecret = process.env.AUTH_JWT_SECRET;
before(async () => {
  process.env.AUTH_JWT_SECRET =
    'health-controller-unit-test-secret-at-least-32-bytes';
  ({ app } = await createBackend());
  const repository = app.get(HealthRepository);
  repository.checkDatabase = async () => {
    await probes.database!();
  };
  repository.getMinioHealth = async () => {
    await probes.minio!();
    return { read: 200, write: 200 };
  };
  const worker = app.get<HealthWorkerProbes>(HEALTH_WORKER_PROBES);
  worker.worker = () => probes.worker!();
  worker.workerReady = () => probes.workerReady!();
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
after(async () => {
  await app?.close();
  if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
  else process.env.AUTH_JWT_SECRET = previousSecret;
});

const healthResponse = (scope: HealthScope, checks: Partial<HealthProbes>) => {
  probes = checks;
  return fetch(`${origin}/api/health${scope === 'overall' ? '' : '/' + scope}`);
};

test('worker liveness skips dependencies and readiness reports each failure without exposing errors', async () => {
  for (const failed of [undefined, 'worker', 'database', 'minio'] as const) {
    const calls: string[] = [];
    const probe = async (name: string) => {
      calls.push(name);
      if (name === failed) throw new Error('secret connection detail');
    };
    const checks = {
      database: () => probe('database'),
      minio: () => probe('minio'),
      worker: () => probe('worker'),
      workerReady: () => probe('worker'),
    };
    const live = await healthResponse('worker', checks);
    assert.deepEqual(calls, ['worker']);
    assert.equal(live.status, failed === 'worker' ? 503 : 200);
    calls.length = 0;
    const ready = await healthResponse('worker/readyz', checks);
    assert.equal(ready.status, failed ? 503 : 200);
    assert.deepEqual(calls.sort(), ['database', 'minio', 'worker']);
    assert.deepEqual(await ready.json(), {
      status: failed ? 'down' : 'ok',
      checks: {
        worker: failed === 'worker' ? 'down' : 'ok',
        database: failed === 'database' ? 'down' : 'ok',
        minio: failed === 'minio' ? 'down' : 'ok',
      },
    });
    assert.equal(ready.headers.get('Cache-Control'), 'no-store');
  }
  for (const check of [
    ['worker', 'extra'],
    ['worker', 'readyz', 'extra'],
    ['overall'],
  ]) {
    assert.equal(
      (
        await fetch(`${origin}/api/health/${check.join('/')}`, {
          headers: {
            authorization: `Bearer ${createAccessToken('health-user', 'health-session')}`,
          },
        })
      ).status,
      404,
    );
  }
  for (const path of [
    '/api/health/worker',
    '/api/health/worker/readyz',
  ] as const) {
    const operation = openApiDocument.paths[path].get;
    assert.deepEqual(operation.security, []);
    assert.ok(operation.responses['503']);
  }
});

test('individual health checks only probe the selected dependency and report failures', async () => {
  for (const scope of ['database', 'minio'] as const) {
    for (const up of [true, false]) {
      const calls: string[] = [];
      const probe = async (name: string) => {
        calls.push(name);
        if (!up) throw new Error('secret connection detail');
      };
      const probes = {
        database: () => probe('database'),
        minio: () => probe('minio'),
      };
      const response = await healthResponse(scope, probes);
      assert.deepEqual(calls, [scope]);
      assert.equal(response.status, up ? 200 : 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), {
        status: up ? 'ok' : 'down',
        checks: { [scope]: up ? 'ok' : 'down' },
      });
      const operation = openApiDocument.paths[`/api/health/${scope}`].get;
      assert.ok(operation.responses['503']);
      const schema = operation.responses['200'].content['application/json']
        .schema as { properties: { checks: { required: string[] } } };
      assert.deepEqual(schema.properties.checks.required, [scope]);
    }
  }
});

test('liveness skips dependencies and overall health reports each failure', async () => {
  let databaseChecks = 0;
  let minioUp = false;
  const probes = {
    database: async () => {
      databaseChecks++;
    },
    minio: async () => {
      if (!minioUp) throw new Error('secret connection detail');
    },
  };

  const live = await healthResponse('live', probes);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), {
    status: 'ok',
    checks: { application: 'ok' },
  });
  assert.equal(databaseChecks, 0);

  const dependencies = await healthResponse('dependencies', probes);
  assert.equal(dependencies.status, 503);
  assert.deepEqual(await dependencies.json(), {
    status: 'down',
    checks: { database: 'ok', minio: 'down' },
  });

  const database = await healthResponse('database', probes);
  assert.equal(database.status, 200);
  assert.deepEqual(await database.json(), {
    status: 'ok',
    checks: { database: 'ok' },
  });
  const minio = await healthResponse('minio', probes);
  assert.equal(minio.status, 503);
  assert.deepEqual(await minio.json(), {
    status: 'down',
    checks: { minio: 'down' },
  });
  assert.equal(databaseChecks, 2);

  minioUp = true;
  const overall = await healthResponse('overall', probes);
  assert.equal(overall.status, 200);
  assert.deepEqual(await overall.json(), {
    status: 'ok',
    checks: { application: 'ok', database: 'ok', minio: 'ok' },
  });
  assert.equal(overall.headers.get('Cache-Control'), 'no-store');
});

test('health routes require MinIO read and write quorum', async () => {
  const live = await GET(new Request('http://localhost/api/health/live'), {
    params: Promise.resolve({ check: ['live'] }),
  });
  assert.equal(live.status, 200);
  const unknown = await GET(
    new Request('http://localhost/api/health/unknown'),
    { params: Promise.resolve({ check: ['unknown'] }) },
  );
  assert.equal(unknown.status, 404);

  const service = new HealthService(new HealthRepository(new PrismaService()), {
    worker: async () => {},
    workerReady: async () => {},
  });
  const originalEndpoint = process.env.MINIO_ENDPOINT;
  const originalFetch = globalThis.fetch;
  process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
  try {
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      assert.equal(init?.cache, 'no-store');
      return new Response(null, { status: 200 });
    };
    assert.deepEqual(await service.checkMinio(), {
      status: 'ok',
      checks: { minio: 'ok' },
    });
    assert.deepEqual(paths.sort(), [
      'http://127.0.0.1:9000/minio/health/cluster',
      'http://127.0.0.1:9000/minio/health/cluster/read',
    ]);
    const minio = await GET(new Request('http://localhost/api/health/minio'), {
      params: Promise.resolve({ check: ['minio'] }),
    });
    assert.equal(minio.status, 200);
    assert.deepEqual(await minio.json(), {
      status: 'ok',
      checks: { minio: 'ok' },
    });
    for (const failedPath of paths) {
      globalThis.fetch = async (input) =>
        new Response(null, {
          status: String(input) === failedPath ? 503 : 200,
        });
      assert.deepEqual(await service.checkMinio(), {
        status: 'down',
        checks: { minio: 'down' },
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.MINIO_ENDPOINT;
    else process.env.MINIO_ENDPOINT = originalEndpoint;
  }
});

test('every Nest health route calls its matching service method for GET and HEAD', async (t) => {
  const service = app.get(HealthService);
  const calls: string[] = [];
  const methods = {
    '': 'checkOverall',
    '/live': 'checkLive',
    '/database': 'checkDatabase',
    '/minio': 'checkMinio',
    '/dependencies': 'checkDependencies',
    '/worker': 'checkWorker',
    '/worker/readyz': 'checkWorkerReady',
  } as const;
  for (const name of Object.values(methods))
    t.mock.method(service, name, async () => {
      calls.push(name);
      return { status: 'down', checks: { database: 'down' } };
    });
  for (const [path, name] of Object.entries(methods)) {
    for (const method of ['GET', 'HEAD']) {
      calls.length = 0;
      const response = await fetch(`${origin}/api/health${path}`, { method });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(calls, [name]);
      if (method === 'HEAD') assert.equal(await response.text(), '');
      else
        assert.deepEqual(await response.json(), {
          status: 'down',
          checks: { database: 'down' },
        });
    }
  }
});

test('synchronous probe errors become down results and concurrent failures are retained', async () => {
  const service = new HealthService(
    {
      checkDatabase: () => {
        throw new Error('secret database detail');
      },
      getMinioHealth: async () => ({ read: 503, write: 503 }),
    },
    {
      worker: () => {
        throw new Error('secret worker detail');
      },
      workerReady: () => {
        throw new Error('secret worker readiness detail');
      },
    },
  );
  assert.deepEqual(await service.checkOverall(), {
    status: 'down',
    checks: { application: 'ok', database: 'down', minio: 'down' },
  });
  assert.deepEqual(await service.checkWorker(), {
    status: 'down',
    checks: { worker: 'down' },
  });
  assert.deepEqual(await service.checkWorkerReady(), {
    status: 'down',
    checks: { worker: 'down', database: 'down', minio: 'down' },
  });
});
