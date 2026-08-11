import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintApplicationKey } from '../../../scripts/agent-keys/key-format.mjs'
import { SystemdCredentialStore } from '../../../scripts/agent-keys/systemd-credential-store.mjs'
import { acquireRuntimeStateCoordinator } from '../../../scripts/runtime-state-coordinator.mjs'

const temporaryRoots = []
const plaintextBuffers = []

const createKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`

const deferred = () => {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const getAvailablePort = () => new Promise((resolve, reject) => {
  const server = createServer()

  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const address = server.address()

    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve(address.port)
    })
  })
})

const createFixture = async (storeOptions = {}) => {
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
  const createStore = (overrides = {}) => new SystemdCredentialStore({
    directory,
    ownerUid: process.getuid(),
    run,
    trustedRoot,
    validateActive,
    ...storeOptions,
    ...overrides
  })
  const store = createStore()

  temporaryRoots.push(trustedRoot)

  return {
    commands,
    createStore,
    directory,
    plaintextByCandidate,
    run,
    store,
    trustedRoot,
    validateActive
  }
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
  it('coordinates every credential-store mutation before touching protected state', async () => {
    const port = await getAvailablePort()
    const fixture = await createFixture({
      coordinatorOptions: { port, timeoutMs: 0 }
    })
    const release = await acquireRuntimeStateCoordinator(
      `agora-agent-credential:${fixture.store.activePath}`,
      { port }
    )
    const key = createKey()
    const stopService = vi.fn(async () => {})

    try {
      const mutations = [
        () => fixture.store.install(Buffer.from(key), fingerprintApplicationKey(key)),
        () => fixture.store.rotate(Buffer.from(key), fingerprintApplicationKey(key)),
        () => fixture.store.commitRotation(),
        () => fixture.store.rollbackRotation(),
        () => fixture.store.revoke(stopService)
      ]

      for (const mutate of mutations) {
        await expect(mutate()).rejects.toThrow(
          'Agora agent credential store is busy; retry the host credential command.'
        )
      }

      expect(await readdir(fixture.trustedRoot)).toEqual([])
      expect(fixture.run).not.toHaveBeenCalled()
      expect(fixture.validateActive).not.toHaveBeenCalled()
      expect(stopService).not.toHaveBeenCalled()
    } finally {
      await release()
    }
  })

  it('serializes overlapping rotations and preserves the original rollback ciphertext', async () => {
    const port = await getAvailablePort()
    const firstSealing = deferred()
    const finishFirstSeal = deferred()
    const secondWaiting = deferred()
    const retrySecond = deferred()
    const fixture = await createFixture({
      coordinatorOptions: { pollIntervalMs: 1, port, timeoutMs: 1000 }
    })
    const secondStore = fixture.createStore({
      coordinatorOptions: {
        pollIntervalMs: 1,
        port,
        sleep: async () => {
          secondWaiting.resolve()
          await retrySecond.promise
        },
        timeoutMs: 1000
      }
    })
    const original = createKey()
    const replacement = createKey()
    let firstRotation
    let secondRotation

    try {
      await install(fixture, original)
      const originalCiphertext = await readFile(fixture.store.activePath)
      const seal = fixture.run.getMockImplementation()
      fixture.run.mockImplementationOnce(async (...args) => {
        firstSealing.resolve()
        await finishFirstSeal.promise
        return seal(...args)
      })

      firstRotation = fixture.store.rotate(
        Buffer.from(replacement),
        fingerprintApplicationKey(replacement)
      )
      await firstSealing.promise

      secondRotation = secondStore.rotate(
        Buffer.from(replacement),
        fingerprintApplicationKey(replacement)
      )
      const secondOutcome = await Promise.race([
        secondWaiting.promise.then(() => 'waiting'),
        secondRotation.then(
          () => 'settled',
          () => 'settled'
        )
      ])

      expect(secondOutcome).toBe('waiting')
      expect(await readFile(fixture.store.activePath)).toEqual(originalCiphertext)

      finishFirstSeal.resolve()
      await expect(firstRotation).resolves.toBe(fingerprintApplicationKey(replacement))
      retrySecond.resolve()
      await expect(secondRotation).rejects.toThrow(
        'A previous encrypted credential is still awaiting commit or rollback.'
      )

      await fixture.store.rollbackRotation()
      expect(await readFile(fixture.store.activePath)).toEqual(originalCiphertext)
      expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
    } finally {
      finishFirstSeal.resolve()
      retrySecond.resolve()
      await Promise.allSettled([firstRotation, secondRotation].filter(Boolean))
    }
  })

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
      '.agora-agent-key.rotation.json',
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

  it('recovers the original after interruption around the old-credential rename', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()
    await install(fixture, original)
    const activePath = path.join(fixture.directory, 'agora-agent-key.cred')
    const rollbackPath = path.join(fixture.directory, '.agora-agent-key.rollback.cred')
    const originalCiphertext = await readFile(activePath)
    const state = fixture.store.rotationState.create(
      fingerprintApplicationKey(replacement)
    )
    const candidatePath = fixture.store.rotationState.candidatePath(state)
    await fixture.store.rotationState.write(state, 'installing')
    await writeFile(candidatePath, randomBytes(96), { mode: 0o600 })
    await rename(activePath, rollbackPath)

    await fixture.store.rollbackRotation()

    expect(await readFile(activePath)).toEqual(originalCiphertext)
    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
  })

  it('recovers the original after interruption around replacement publication', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()
    await install(fixture, original)
    const activePath = path.join(fixture.directory, 'agora-agent-key.cred')
    const rollbackPath = path.join(fixture.directory, '.agora-agent-key.rollback.cred')
    const originalCiphertext = await readFile(activePath)
    const state = fixture.store.rotationState.create(
      fingerprintApplicationKey(replacement)
    )
    const candidatePath = fixture.store.rotationState.candidatePath(state)
    const replacementCiphertext = randomBytes(96)
    await fixture.store.rotationState.write(state, 'installing')
    await writeFile(candidatePath, replacementCiphertext, { mode: 0o600 })
    await rename(activePath, rollbackPath)
    await rename(candidatePath, activePath)

    await fixture.store.rollbackRotation()

    expect(await readFile(activePath)).toEqual(originalCiphertext)
    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
  })

  it('finishes interrupted rollback and commit transitions idempotently', async () => {
    const rollbackFixture = await createFixture()
    const original = createKey()
    const replacement = createKey()
    await install(rollbackFixture, original)
    const originalCiphertext = await readFile(rollbackFixture.store.activePath)
    await rollbackFixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )
    let state = await rollbackFixture.store.rotationState.read()
    state = await rollbackFixture.store.rotationState.write(state, 'rolling-back')
    await rename(
      rollbackFixture.store.activePath,
      rollbackFixture.store.rotationState.candidatePath(state)
    )

    await rollbackFixture.store.rollbackRotation()
    expect(await readFile(rollbackFixture.store.activePath)).toEqual(originalCiphertext)
    expect(await readdir(rollbackFixture.directory)).toEqual(['agora-agent-key.cred'])

    const commitFixture = await createFixture()
    await install(commitFixture, original)
    await commitFixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )
    state = await commitFixture.store.rotationState.read()
    await commitFixture.store.rotationState.write(state, 'committing')
    await unlink(commitFixture.store.rollbackPath)

    await commitFixture.store.commitRotation()
    expect(await readdir(commitFixture.directory)).toEqual(['agora-agent-key.cred'])
  })

  it('recovers the exact legacy crash shape reported by review', async () => {
    const fixture = await createFixture()
    const original = createKey()
    await install(fixture, original)
    const originalCiphertext = await readFile(fixture.store.activePath)
    await rename(fixture.store.activePath, fixture.store.rollbackPath)

    await fixture.store.rollbackRotation()

    expect(await readFile(fixture.store.activePath)).toEqual(originalCiphertext)
    expect(await readdir(fixture.directory)).toEqual(['agora-agent-key.cred'])
  })

  it('keeps raw keys out of durable rotation state', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()
    await install(fixture, original)
    await fixture.store.rotate(
      Buffer.from(replacement),
      fingerprintApplicationKey(replacement)
    )
    const state = await readFile(
      path.join(fixture.directory, '.agora-agent-key.rotation.json'),
      'utf8'
    )

    expect(state).not.toContain(original)
    expect(state).not.toContain(replacement)
    expect(state).toContain(fingerprintApplicationKey(replacement))
  })

  it('rejects a cross-field-corrupt journal before changing credential files', async () => {
    const fixture = await createFixture()
    const original = createKey()
    const replacement = createKey()
    await install(fixture, original)
    const activeCiphertext = await readFile(fixture.store.activePath)
    const firstState = fixture.store.rotationState.create(
      fingerprintApplicationKey(replacement)
    )
    const otherState = fixture.store.rotationState.create(
      fingerprintApplicationKey(createKey())
    )
    const otherCandidatePath = fixture.store.rotationState.candidatePath(otherState)
    const otherCandidateCiphertext = randomBytes(96)
    const statePath = path.join(fixture.directory, '.agora-agent-key.rotation.json')
    const corruptedState = `${JSON.stringify({
      ...firstState,
      candidateName: otherState.candidateName,
      phase: 'installing'
    })}\n`
    await writeFile(otherCandidatePath, otherCandidateCiphertext, { mode: 0o600 })
    await writeFile(statePath, corruptedState, { mode: 0o600 })
    const filenames = (await readdir(fixture.directory)).sort()

    await expect(fixture.store.rollbackRotation()).rejects.toThrow(
      'Credential rotation state is malformed.'
    )

    expect((await readdir(fixture.directory)).sort()).toEqual(filenames)
    expect(await readFile(fixture.store.activePath)).toEqual(activeCiphertext)
    expect(await readFile(otherCandidatePath)).toEqual(otherCandidateCiphertext)
    expect(await readFile(statePath, 'utf8')).toBe(corruptedState)
    expect(fixture.validateActive).toHaveBeenCalledTimes(1)
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
