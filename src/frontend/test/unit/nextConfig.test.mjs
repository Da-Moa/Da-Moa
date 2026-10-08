import assert from 'node:assert/strict'
import { test } from 'node:test'

test('development origins only allow hosts explicitly configured in the environment', async t => {
  const previous = process.env.NEXT_DEV_ALLOWED_ORIGINS
  t.after(() => {
    if (previous === undefined) delete process.env.NEXT_DEV_ALLOWED_ORIGINS
    else process.env.NEXT_DEV_ALLOWED_ORIGINS = previous
  })

  for (const [value, expected] of [
    [undefined, []],
    ['', []],
    [' ,  , ', []],
    ['192.168.0.10', ['192.168.0.10']],
    [' 192.168.0.10, dev.example.com, , *.local.example.com ', ['192.168.0.10', 'dev.example.com', '*.local.example.com']],
  ]) {
    if (value === undefined) delete process.env.NEXT_DEV_ALLOWED_ORIGINS
    else process.env.NEXT_DEV_ALLOWED_ORIGINS = value
    const { default: config } = await import(`../../../../next.config.mjs?origins=${encodeURIComponent(value)}`)
    assert.deepEqual(config.allowedDevOrigins, expected)
  }
})
