import { defineConfig, devices } from '@playwright/test';

const database = process.env.TEST_DATABASE_URL;
if (
  !database ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) ||
  !new URL(database).pathname.toLowerCase().includes('test')
) {
  throw new Error('Browser tests require an isolated local TEST_DATABASE_URL');
}
const port = Number(process.env.BROWSER_TEST_PORT || '3307');
const metricsPort = Number(process.env.BROWSER_TEST_METRICS_PORT || '3308');
if (
  ![port, metricsPort].every(
    (value) => Number.isInteger(value) && value > 1024 && value < 65536,
  ) ||
  port === metricsPort ||
  port === 3000
)
  throw new Error('Invalid isolated browser test ports');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './src/frontend/test/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/browser/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/browser/results.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node dist/main.js',
    url: `${baseURL}/api/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      DATABASE_URL: database,
      KAKAO_REDIRECT_URI: `${baseURL}/api/auth/kakao/callback`,
      RECEIPT_WORKER_ENABLED: 'false',
    },
  },
});
