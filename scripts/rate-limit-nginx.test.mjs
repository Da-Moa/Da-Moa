import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const directory = mkdtempSync(join(tmpdir(), 'da-moa-nginx-rate-limit-'))
const container = `da-moa-rate-limit-check-${process.pid}`
const image = 'nginx:stable-alpine'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
writeFileSync(join(directory, 'nginx.conf'), `
events { worker_connections 2048; }
http {
  access_log off;
  error_log /dev/null;
  include /rate-limit/rate-limit-zones.conf;
  server {
    listen 80;
    root /usr/share/nginx/html;
    include /rate-limit/rate-limit-server.conf;
    location / { try_files /index.html =404; }
    location ~ ^/api/rounds/[^/]+/expenses/[^/]+/receipts/?$ { try_files /index.html =404; }
    location = /realtime { try_files /index.html =404; }
  }
}
`)
const mounts = ['--mount', `type=bind,source=${join(directory, 'nginx.conf')},target=/etc/nginx/nginx.conf,readonly`,
  '--mount', `type=bind,source=${resolve('deploy/nginx')},target=/rate-limit,readonly`]
try {
  docker('run', '--rm', ...mounts, image, 'nginx', '-t')
  docker('run', '-d', '--name', container, '-p', '127.0.0.1::80', ...mounts, image)
  const port = docker('port', container, '80/tcp').split(':').at(-1)
  const origin = `http://127.0.0.1:${port}`
  for (let attempts = 0; ; attempts++) {
    try { await fetch(origin); break }
    catch (error) { if (attempts >= 30) throw error; await setTimeout(100) }
  }
  const paths = ['/api/me', '/api/groups', '/api/rounds/a/expenses/b/receipts', '/realtime']
  const started = performance.now()
  const responses = await Promise.all(Array.from({ length: 600 }, (_, i) => fetch(`${origin}${paths[i % paths.length]}`)))
  const elapsed = (performance.now() - started) / 1000
  const accepted = responses.filter(response => response.status === 200).length
  const denied = responses.filter(response => response.status === 429)
  assert.equal(accepted + denied.length, responses.length)
  assert.ok(accepted > 0 && denied.length > 0, 'global burst must admit some requests and reject the excess')
  assert.ok(accepted <= 52 + Math.ceil(297 * elapsed), 'all API/receipt/WS locations must share the global budget')
  for (const response of denied) {
    assert.equal(response.headers.get('Retry-After'), '1')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal((await response.json()).error, 'rate_limited')
  }
  await Promise.all(responses.filter(response => response.status === 200).map(response => response.arrayBuffer()))
  assert.equal((await fetch(origin)).status, 200, 'pages/static content stays available after API quota exhaustion')
  await setTimeout(1000)
  const logins = await Promise.all(Array.from({ length: 20 }, () => fetch(`${origin}/api/auth/kakao`)))
  const allowedLogins = logins.filter(response => response.status === 200).length
  assert.ok(allowedLogins > 0 && allowedLogins <= 6)
  for (const response of logins) {
    if (response.status === 429) assert.equal(response.headers.get('Retry-After'), '6')
    await response.arrayBuffer()
  }
  console.log(`PASS nginx -t; shared 297 RPS budget: ${accepted} accepted / ${denied.length} rejected; login IP burst: ${allowedLogins} accepted / ${20 - allowedLogins} rejected; static exemption`)
} finally {
  try { docker('rm', '-f', container) } catch { /* Container may not have started. */ }
  rmSync(directory, { recursive: true, force: true })
}
