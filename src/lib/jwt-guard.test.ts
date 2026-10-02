import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import proxyTesting from 'next/experimental/testing/server'
import { proxy, config } from '../proxy'
import { ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, createAccessToken, createRefreshToken, currentTimestamp } from './auth'

const { unstable_doesMiddlewareMatch: doesProxyMatch } = proxyTesting

test('Node JWT guard rejects protected requests before body validation and permits only explicit public routes', async () => {
  const previous = process.env.AUTH_JWT_SECRET
  process.env.AUTH_JWT_SECRET = 'isolated-jwt-guard-test-secret-at-least-32-bytes'
  try {
    const now = currentTimestamp()
    const access = createAccessToken('user', 'session')
    const refresh = createRefreshToken('user', 'session')
    const request = (path: string, method = 'GET', cookie = '') => new NextRequest(`http://localhost${path}`, {
      method, headers: { cookie, ...(cookie.startsWith(`${ACCESS_TOKEN_COOKIE_NAME}=`) ? { authorization: `Bearer ${cookie.slice(ACCESS_TOKEN_COOKIE_NAME.length + 1)}` } : {}), 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' },
      ...(method === 'POST' ? { body: '{invalid json' } : {}),
    })
    for (const path of ['/api/groups', '/api/me', '/api/me/onboarding', '/api/me/bank-account', '/api/rounds/id', '/api/invites/token', '/api/docs', '/api/openapi.json', '/api/unknown']) {
      assert.equal(doesProxyMatch({ config, nextConfig: {}, url: path }), true)
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const denied = proxy(request(path, method))
        assert.equal(denied.status, 401, `${method} ${path}`)
        assert.equal(denied.headers.get('Cache-Control'), 'private, no-store')
      }
    }
    for (const token of ['invalid', `${access.slice(0, -1)}!`, createAccessToken('user', 'session', undefined, now - 10, 1), refresh]) {
      assert.equal(proxy(request('/api/groups', 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${token}`)).status, 401)
    }
    assert.equal(proxy(request('/api/groups', 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`)).headers.get('x-middleware-next'), '1')
    assert.equal(proxy(new NextRequest('http://localhost/api/groups', { headers: { cookie: `${ACCESS_TOKEN_COOKIE_NAME}=${access}` } })).status, 401)
    for (const path of ['/api/health', '/api/health/live', '/api/health/database', '/api/health/minio', '/api/health/dependencies']) {
      for (const method of ['GET', 'HEAD']) assert.equal(proxy(request(path, method)).headers.get('x-middleware-next'), '1')
      assert.equal(proxy(request(path, 'POST')).status, 401)
    }
    for (const path of ['/api/health-extra', '/api/health/live/extra', '/api/auth/kakao/extra', '/api/auth/test-login/extra', '/api/auth/unknown']) {
      assert.equal(proxy(request(path)).status, 401)
    }
    assert.equal(proxy(request('/api/auth/kakao')).headers.get('x-middleware-next'), '1')
    assert.equal(proxy(request('/api/auth/kakao', 'POST')).status, 401)
    assert.equal(proxy(request('/api/auth/test-login', 'POST')).headers.get('x-middleware-next'), '1')
    const refreshCookie = `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}`
    for (const path of ['/api/auth/refresh', '/api/auth/access-token']) {
      assert.equal(proxy(request(path, 'POST', refreshCookie)).headers.get('x-middleware-next'), '1')
      assert.equal(proxy(request(path, 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`)).status, 401)
    }
    assert.equal(proxy(request('/api/auth/refresh', 'POST', `${REFRESH_TOKEN_COOKIE_NAME}=${access}`)).status, 401)
    const refreshDenied = proxy(request('/api/auth/refresh', 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`))
    assert.equal(refreshDenied.status, 401)
    assert.match(refreshDenied.headers.get('set-cookie')!, /Max-Age=0/)
    assert.equal(proxy(request('/api/auth/logout', 'POST', refreshCookie)).headers.get('x-middleware-next'), '1')
    assert.equal(proxy(request('/api/auth/logout', 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`)).headers.get('x-middleware-next'), '1')
    assert.equal(proxy(request('/api/auth/logout', 'POST')).status, 401)
    for (const path of ['/', '/login', '/auth/v1/kakao', '/_next/static/app.js', '/logo/logo.png']) {
      assert.equal(doesProxyMatch({ config, nextConfig: {}, url: path }), false)
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET
    else process.env.AUTH_JWT_SECRET = previous
  }
})
