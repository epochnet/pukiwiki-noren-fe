import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// E2E runs the real BFF (serving the built web app) against the local test PukiWiki
// started by dev/pukiwiki-test/compose.yml and seeded with dev/seed-test-wiki.py.
const PORT = 18282;
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'noren-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node apps/bff/src/main.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUKIWIKI_URL: process.env.TEST_PUKIWIKI_URL ?? 'http://127.0.0.1:18090/',
      PUKIWIKI_ADMIN_PASSWORD: 'testpass',
      PUKIWIKI_LABEL: 'テスト Wiki',
      DATA_DIR: dataDir,
      SYNC_INTERVAL: '3',
      AGENT_ENABLED: 'true',
      ANTHROPIC_API_KEY: '',
      AGENT_EXCLUDE_PAGES: 'VPS,VPS/*',
    },
  },
});
