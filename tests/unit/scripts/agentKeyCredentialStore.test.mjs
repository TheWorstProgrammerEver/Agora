import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintApplicationKey } from '../../../scripts/agent-keys/key-format.mjs'
import { SystemdCredentialStore } from '../../../scripts/agent-keys/systemd-credential-store.mjs'

const temporaryRoots = []
const plaintextBuffers = []

const createKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`

const createFixture = async () => {
  const trustedRoot = await mkdtemp(path.join(tmpdir(), 'agora-agent-key-test-'))
  const directory = path.join(trustedRoot, 'credstore.encrypted')
  const plaintextByCandidate = new Map()
  const commands = []
  const run = vi.fn(async (file, args, options = {}) => {
    commands.push({ args, file })
    const command = args.find((value) => ['decrypt', 'encrypt'].includes(value))

    if (command === 'encrypt') {
      const candidatePath = args.at(-1)
      const plaintext = Buffer.from(options.input)
      plaintextBuffers.push(plaintext)
      plaintextByCandidate.set(candidatePath, plaintext)
      await writeFile(candidatePath, randomBytes(96), { mode: 0o600 })
      return Buffer.alloc(0)
    }

    if (command === 'decrypt') {
      return Buffer.from(plaintextByCandidate.get(args.at(-2)))
    }

    throw new Error('Unexpected test command.')
  })
  const validateActive = vi.fn(async () => {})
  const store = new SystemdCredentialStore({
    directory,
    ownerUid: process.getuid(),
    run,
    trustedRoot,
    validateActive
  })

  temporaryRoots.push(trustedRoot)

  return { commands, directory, plaintextByCandidate, store, validateActive }
}

const install = async (fixture, key) => fixture.store.install(
  Buffer.from(key),
  fingerprintApplicationKey(key)
)

afterEach(async () => {
  for (const plaintext of plaintextBuffers.splice(0)) {
    plaintext.fill(0)
  }

  for (const root of temporaryRoots.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true }))
  }
})

describe('systemd encrypted credential custody', () => {
  it('installs only ciphertext and keeps the raw key out of process arguments', async () => {
    const fixture = await createFixture()
    const key = createKey()
    const fingerprint = await install(fixture, key)
    const filenames = await readdir(fixture.directory)
    const ciphertext = await readFile(path.join(fixture.directory, 'agora-agent-key.cred'))

    expect(fingerprint).toBe(fingerprintApplicationKey(key))
    expect(filenames).toEqual(['agora-agent-key.cred'])
    expect(ciphertext.includes(key)).toBe(false)
    expect(JSON.stringify(fixture.commands)).not.toContain(key)
    expect(fixture.commands[0].args).toContain('--with-key=host')
    expect(fixture.validateActive).toHaveBeenCalledWith({
      fingerprint,
      path: path.join(fixture.directory, 'agora-agent-key.cred')
    })
  })

  it('retains encrypted rollback material until commit', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()

    await install(fixture, original)
    await fixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )

    expect((await readdir(fixture.directory)).sort()).toEqual([
      '.agora-agent-key.rollback.cred',
      'agora-agent-key.cred'
    ])

    await fixture.store.commitRotation()
    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
  })

  it('restores the old ciphertext when replacement validation fails', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()

    await install(fixture, original)
    fixture.validateActive.mockRejectedValueOnce(new Error('replacement rejected'))

    await expect(fixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )).rejects.toThrow('replacement rejected')

    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
    expect(fixture.validateActive).toHaveBeenCalledTimes(3)
  })

  it('rolls back a staged replacement and validates the restored credential', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()

    await install(fixture, original)
    await fixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )
    await fixture.store.rollbackRotation()

    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
    expect(fixture.validateActive).toHaveBeenCalledTimes(3)
  })

  it('removes every encrypted artifact even when service stop reports failure', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()

    await install(fixture, original)
    await fixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )

    await expect(fixture.store.revoke(
      async () => { throw new Error('stop failed') }
    )).rejects.toThrow('stop failed')
    expect(await readdir(fixture.directory)).toEqual([])
  })

  it('rejects the wrong fingerprint before sealing secret bytes', async () => {
    const fixture = await createFixture()
    const key = createKey()

    await expect(fixture.store.install(
      Buffer.from(key),
      'sha256:0000000000000000'
    )).rejects.toThrow('does not match')
    expect(fixture.commands).toEqual([])
  })
})
