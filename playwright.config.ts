import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/visual',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Desktop Chrome']
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1',
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:4173'
  }
})
