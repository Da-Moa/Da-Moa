import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runner = new URL(
  '../../../../scripts/runBackendTests.mjs',
  import.meta.url,
);

test('백엔드 테스트 실행기가 개발·원격·잘못된 DB 주소를 테스트 시작 전에 거부하고 인증 정보를 출력하지 않는다', () => {
  for (const database of [
    'postgresql://test-user:private-test-password@127.0.0.1/da_moa_dev',
    'postgresql://test-user:private-test-password@remote.invalid/da_moa_test',
    'https://test-user:private-test-password@localhost/da_moa_test',
    'private-test-password',
  ]) {
    const result = spawnSync(process.execPath, [runner.pathname, 'domain'], {
      env: { ...process.env, TEST_DATABASE_URL: database },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /로컬 PostgreSQL 테스트 DB/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /private-test-password|PostgreSQL을 준비|도메인 테스트/,
    );
  }
});

test('백엔드 테스트 실행기가 알 수 없는 계층을 거부하고 Docker를 시작하지 않는다', () => {
  const result = spawnSync(process.execPath, [runner.pathname, 'unknown'], {
    env: { ...process.env, TEST_DATABASE_URL: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /테스트 계층을 지정/);
  assert.doesNotMatch(result.stdout, /PostgreSQL을 준비/);
});

test('테스트 DB 준비 실패 시 이번 실행의 Compose 프로젝트만 정리하고 실패 코드를 유지한다', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'da-moa-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'commands.jsonl');
  writeFileSync(
    join(directory, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNNER_TEST_LOG, JSON.stringify(args) + '\\n');
process.exit(args.includes('up') ? 23 : 0);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [runner.pathname, 'domain'], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: '',
      PATH: directory,
      RUNNER_TEST_LOG: log,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 23);
  const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('up'));
  assert.ok(commands[1].includes('down'));
  assert.ok(commands[1].includes('--volumes'));
  const project = (args) => args[args.indexOf('-p') + 1];
  assert.match(project(commands[0]), /^da-moa-test-[a-f0-9]{32}$/);
  assert.equal(project(commands[0]), project(commands[1]));
  assert.doesNotMatch(result.stdout, /도메인 테스트/);
});
