import { randomUUID } from 'node:crypto'
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableRunnerStore } from '../../../scripts/agent-runner/durable-store.mjs'
import { createDurablePlan, reconcileGroups } from '../../../scripts/agent-runner/state-machine.mjs'

const roots = []
const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-runner-store-'))
  roots.push(root)
  const store = new DurableRunnerStore(root)
  await store.initialize()
  return store
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('durable runner store', () => {
  it('atomically persists private validated state', async () => {
    const store = await createStore()
    const principalId = randomUUID()
    const groupId = randomUUID()

    await store.update((state) => reconcileGroups(state, {
      groups: [{ highWatermarkSequence: '8', id: groupId, unreadCount: 3 }],
      principalId
    }))

    await expect(store.read()).resolves.toMatchObject({
      groups: { [groupId]: { cursor: '5', observedHighWatermark: '8' } },
      principalId
    })
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600)
    expect((await stat(store.root)).mode & 0o777).toBe(0o700)
    expect((await readFile(store.statePath, 'utf8'))).not.toContain('.agora-write-')
  })

  it('binds a private durable plan to its digest and removes it after commit', async () => {
    const store = await createStore()
    const lease = {
      chunkId: 'a'.repeat(64),
      fromExclusive: '2',
      through: '4'
    }
    const plan = createDurablePlan(lease, randomUUID(), [{ text: 'Example response' }])
    const identity = await store.writePlan(plan)

    await expect(store.readPlan(lease.chunkId, identity.digest)).resolves.toEqual(plan)
    await expect(store.readPlan(lease.chunkId, `sha256:${'b'.repeat(64)}`))
      .rejects.toThrow('identity is invalid')
    expect((await stat(join(store.planDirectory, `${lease.chunkId}.json`))).mode & 0o777)
      .toBe(0o600)
    await store.deletePlan(lease.chunkId)
    await expect(store.readPlan(lease.chunkId, identity.digest)).rejects.toThrow('unavailable')
  })

  it('cleans only exact private interrupted artifacts', async () => {
    const store = await createStore()
    const exact = `.agora-write-${randomUUID()}.tmp`
    const nearMatch = `${exact}.keep`
    await writeFile(join(store.root, exact), 'generated fixture', { mode: 0o600 })
    await writeFile(join(store.root, nearMatch), 'preserve fixture', { mode: 0o600 })

    await store.cleanupInterruptedFiles()

    await expect(readFile(join(store.root, exact))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(store.root, nearMatch), 'utf8')).resolves.toBe('preserve fixture')
  })

  it('fails closed on an unsafe existing state directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-runner-store-'))
    roots.push(root)
    await chmod(root, 0o777)

    await expect(new DurableRunnerStore(root).initialize())
      .rejects.toThrow('custody is invalid')
  })

  it('reads complete generations while state is atomically replaced', async () => {
    const store = await createStore()
    const principalId = randomUUID()
    await store.update((state) => {
      state.principalId = principalId
    })

    const writer = async () => {
      for (let index = 0; index < 100; index += 1) {
        await store.update((state) => {
          state.lastActivity = {
            at: new Date(index + 1).toISOString(),
            code: 'replacement',
            status: 'healthy'
          }
        })
      }
    }
    const reader = async () => {
      for (let index = 0; index < 100; index += 1) {
        expect((await store.read()).principalId).toBe(principalId)
      }
    }

    await Promise.all([writer(), ...Array.from({ length: 20 }, reader)])
    expect((await store.read()).lastActivity?.code).toBe('replacement')
  })

  it('rejects symlinked state and multiply-linked durable plans', async () => {
    const store = await createStore()
    const outsideState = join(store.root, 'outside-state.json')
    await writeFile(outsideState, '{"generated":"fixture"}', { mode: 0o600 })
    await symlink(outsideState, store.statePath)
    await expect(store.read()).rejects.toThrow('could not be read')
    await rm(store.statePath)

    const lease = {
      chunkId: 'c'.repeat(64),
      fromExclusive: '0',
      through: '1'
    }
    const plan = createDurablePlan(lease, randomUUID(), [])
    const identity = await store.writePlan(plan)
    await link(
      join(store.planDirectory, `${lease.chunkId}.json`),
      join(store.root, 'linked-plan.json')
    )
    await expect(store.readPlan(lease.chunkId, identity.digest)).rejects.toThrow('unavailable')
  })
})
