import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:3200',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://127.0.0.1:3201/api/v1/health',
      timeout: 60_000,
    },
    { command: 'pnpm exec next start --port 3200', url: 'http://127.0.0.1:3200', timeout: 60_000 },
  ],
});
