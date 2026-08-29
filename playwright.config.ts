import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => existsSync(path))

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    browserName: 'chromium',
    executablePath: chromiumExecutablePath,
    channel: chromiumExecutablePath ? undefined : process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure'
  }
})
