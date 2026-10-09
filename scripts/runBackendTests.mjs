import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = {
  unit: ['src/backend/test/unit', 'src/frontend/test/unit'],
  domain: ['src/backend/test/domain'],
  integration: ['src/backend/test/integration'],
  scenario: ['src/backend/test/scenario'],
  smoke: ['src/backend/test/integration/routes.integration.test.ts'],
};
let active;
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal;
    if (!active?.cleanup) active?.child.kill(signal);
  });
}

function command(program, args, env, capture = false, cleanup = false) {
  if (interrupted && !cleanup) throw new Error('테스트 실행이 중단됐습니다.');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    active = { child, cleanup };
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (active?.child === child) active = undefined;
      if (code === 0) resolve(output.trim());
      else
        reject(
          Object.assign(
            new Error(`${program} 실행 실패${signal ? ` (${signal})` : ''}`),
            { exitCode: code || 1 },
          ),
        );
    });
  });
}

function validateDatabase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* Report no connection credentials. */
  }
  if (
    !url ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.pathname.includes('test')
  ) {
    throw new Error(
      'TEST_DATABASE_URL은 이름에 test가 포함된 로컬 PostgreSQL 테스트 DB여야 합니다. 개발·운영 DB는 사용할 수 없습니다.',
    );
  }
}

async function runSuite(kind, env) {
  const files = [];
  for (const path of suites[kind]) {
    if (path.endsWith('.ts')) files.push(path);
    else
      files.push(
        ...(await readdir(new URL(`../${path}/`, import.meta.url)))
          .filter((name) => /\.test\.(ts|mjs)$/.test(name))
          .sort()
          .map((name) => `${path}/${name}`),
      );
  }
  await command(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      '--test',
      '--test-reporter=./scripts/testReporter.mjs',
      ...(kind === 'unit' ? [] : ['--test-concurrency=1']),
      ...files,
    ],
    { ...env, SWC_NODE_PROJECT: 'tsconfig.backend.json' },
  );
}

async function main() {
  const kind = process.argv[2];
  if (!Object.hasOwn(suites, kind) && kind !== 'all')
    throw new Error(
      '테스트 계층을 지정하세요: domain, integration, scenario, smoke, all',
    );
  const kinds =
    kind === 'all' ? ['unit', 'domain', 'integration', 'scenario'] : [kind];
  const env = { ...process.env };
  if (env.TEST_DATABASE_URL) validateDatabase(env.TEST_DATABASE_URL);
  if (kinds[0] === 'unit') {
    await runSuite('unit', env);
    kinds.shift();
  }
  if (!kinds.length) return;

  let compose;
  try {
    if (!env.TEST_DATABASE_URL) {
      const id = randomUUID().replaceAll('-', '');
      const database = `da_moa_${id}_test`;
      env.CI_TEST_DATABASE = database;
      env.CI_TEST_POSTGRES_PORT = '0';
      compose = [
        'compose',
        '--env-file',
        '/dev/null',
        '-f',
        'compose.mock-test.yaml',
        '-p',
        `da-moa-test-${id}`,
      ];
      console.log(
        '\n테스트 전용 PostgreSQL을 준비합니다. Docker가 실행 중이어야 합니다.',
      );
      await command(
        'docker',
        [...compose, 'up', '-d', '--wait', '--wait-timeout', '60'],
        env,
      );
      const binding = await command(
        'docker',
        [...compose, 'port', 'postgres', '5432'],
        env,
        true,
      );
      const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
      if (!port)
        throw new Error('테스트 PostgreSQL의 로컬 포트를 확인하지 못했습니다.');
      env.TEST_DATABASE_URL = `postgresql://da_moa_ci:da_moa_ci_test@127.0.0.1:${port}/${database}`;
      console.log('테스트 전용 PostgreSQL 준비 완료\n');
    }
    env.DATABASE_URL = env.TEST_DATABASE_URL;
    env.POSTGRES_URL = env.TEST_DATABASE_URL;
    env.AUTH_JWT_SECRET ||= 'local-only-backend-test-secret-at-least-32-bytes';
    env.RECEIPT_WORKER_ENABLED = 'false';
    for (const suite of kinds) await runSuite(suite, env);
  } finally {
    if (compose) {
      console.log('\n이번 실행에서 생성한 테스트 PostgreSQL을 정리합니다.');
      await command(
        'docker',
        [...compose, 'down', '--volumes'],
        env,
        false,
        true,
      );
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode =
    interrupted === 'SIGINT'
      ? 130
      : interrupted === 'SIGTERM'
        ? 143
        : error.exitCode || 1;
}
