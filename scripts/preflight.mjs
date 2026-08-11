import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const checkDocker = async ({ runCommand = execFileAsync } = {}) => {
  try {
    await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 })
    return { name: 'Docker daemon', ready: true }
  } catch {
    return {
      name: 'Docker daemon',
      ready: false,
      guidance: 'Install and start Docker Engine (Linux) or Docker Desktop (macOS), then confirm docker info succeeds.'
    }
  }
}

export const checkPlaywright = async ({ loadPlaywright = () => import('@playwright/test') } = {}) => {
  let browser

  try {
    const { chromium } = await loadPlaywright()
    browser = await chromium.launch({ headless: true })
    await browser.close()
    return { name: 'Playwright Chromium runtime', ready: true }
  } catch {
    await browser?.close().catch(() => {})
    return {
      name: 'Playwright Chromium runtime',
      ready: false,
      guidance: 'Install the browser with npx playwright install chromium. On Linux, also install its OS libraries with npx playwright install --with-deps chromium or sudo npx playwright install-deps chromium.'
    }
  }
}

export const runPreflight = async (checks = [checkDocker, checkPlaywright]) => {
  const results = await Promise.all(checks.map((check) => check()))

  for (const result of results) {
    console.log(`${result.ready ? 'READY' : 'MISSING'}: ${result.name}`)
    if (!result.ready) {
      console.log(`  ${result.guidance}`)
    }
  }

  return results.every(({ ready }) => ready)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runPreflight() ? 0 : 1
}
