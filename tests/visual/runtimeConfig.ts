import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { SupportedAuthenticationTypes } from '../../src/domain/auth'

const testConfig = JSON.parse(readFileSync('tests/visual/config.test.json', 'utf8'))

type RuntimeConfigOverride = {
  supportedTypes?: SupportedAuthenticationTypes
}

export const routeRuntimeConfig = async (page: Page, override: RuntimeConfigOverride = {}) => {
  const config = {
    ...testConfig,
    auth: {
      ...testConfig.auth,
      supportedTypes: override.supportedTypes ?? testConfig.auth.supportedTypes
    }
  }

  await page.route('**/config.local.json', async (route) => route.fulfill({
    body: JSON.stringify(config),
    contentType: 'application/json'
  }))
}
