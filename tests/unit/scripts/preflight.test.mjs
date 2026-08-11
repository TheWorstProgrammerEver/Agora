import { describe, expect, it, vi } from 'vitest'
import { checkDocker, checkPlaywright, runPreflight } from '../../../scripts/preflight.mjs'

describe('runtime preflight', () => {
  it('passes a ready Docker daemon and browser runtime', async () => {
    const close = vi.fn()
    const loadPlaywright = async () => ({
      chromium: { launch: async () => ({ close }) }
    })

    await expect(checkDocker({ runCommand: async () => {} })).resolves.toMatchObject({ ready: true })
    await expect(checkPlaywright({ loadPlaywright })).resolves.toMatchObject({ ready: true })
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports intentionally missing runtime fixtures without provisioning the host', async () => {
    const docker = await checkDocker({ runCommand: async () => { throw new Error('missing') } })
    const browser = await checkPlaywright({
      loadPlaywright: async () => ({ chromium: { launch: async () => { throw new Error('missing library') } } })
    })

    expect(docker).toMatchObject({ ready: false })
    expect(browser).toMatchObject({ ready: false })
    await expect(runPreflight([
      async () => docker,
      async () => browser
    ])).resolves.toBe(false)
  })
})
