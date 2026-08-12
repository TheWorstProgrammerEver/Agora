import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAgentCredential } from '../../../scripts/agent-runner/credential.mjs'

const roots = []
const exampleKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`
const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-runner-credential-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('agent runner credential custody', () => {
  it('reads only the private systemd credential leaf', async () => {
    const root = await createRoot()
    const key = exampleKey()
    await writeFile(join(root, 'agora-agent-key'), key, { mode: 0o400 })

    await expect(readAgentCredential(root)).resolves.toBe(key)
  })

  it('rejects an overly broad credential mode without projecting bytes', async () => {
    const root = await createRoot()
    const key = exampleKey()
    const path = join(root, 'agora-agent-key')
    await writeFile(path, key, { mode: 0o600 })
    await chmod(path, 0o644)

    await expect(readAgentCredential(root)).rejects.toSatisfy((error) => (
      error.message === 'Agora runner credential custody is invalid.'
      && !error.message.includes(key)
    ))
  })

  it('rejects a symlink credential before reading its target', async () => {
    const root = await createRoot()
    const outside = join(root, 'outside')
    await writeFile(outside, exampleKey(), { mode: 0o400 })
    await symlink(outside, join(root, 'agora-agent-key'))

    await expect(readAgentCredential(root)).rejects.toThrow('custody is invalid')
  })

  it('rejects an oversized credential before reading its content', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'agora-agent-key'), 'x'.repeat(129), { mode: 0o400 })

    await expect(readAgentCredential(root)).rejects.toThrow('custody is invalid')
  })
})
