import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createEmptyRunnerState,
  validateDurablePlan,
  validateRunnerState
} from './state-schema.mjs'

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`
const maximumStateBytes = 16 * 1024 * 1024
const maximumPlanBytes = 64 * 1024

const syncDirectory = async (directory) => {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const validatePrivateDirectory = async (directory) => {
  const stat = await lstat(directory)
  const currentUid = process.getuid?.()

  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== currentUid
    || (stat.mode & 0o077) !== 0) {
    throw new Error('Agora runner state directory custody is invalid.')
  }
}

const createPrivateDirectory = async (directory) => {
  try {
    await validatePrivateDirectory(directory)
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  await validatePrivateDirectory(directory)
}

const readPrivateFile = async (path, maximumBytes) => {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    // Atomic replacement can unlink the complete old generation after open()
    // but before fstat(). That already-open inode is safe at nlink 0; extra
    // hard links remain invalid.
    if (!stat.isFile()
      || stat.uid !== process.getuid?.()
      || stat.nlink > 1
      || (stat.mode & 0o077) !== 0
      || stat.size > maximumBytes) {
      throw new Error('Agora runner private file custody is invalid.')
    }
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle?.close()
  }
}

const atomicWrite = async (path, source) => {
  const directory = dirname(path)
  const temporary = join(directory, `.agora-write-${randomUUID()}.tmp`)
  let handle

  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(source)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(directory)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
    await syncDirectory(directory)
  }
}

const removeOwnedResidue = async (directory, pattern) => {
  const entries = await readdir(directory, { withFileTypes: true })
  let removed = false

  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue
    const path = join(directory, entry.name)
    const stat = await lstat(path)
    if (!entry.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== process.getuid?.()
      || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0) {
      throw new Error('Agora runner recovery residue is invalid.')
    }
    await rm(path)
    removed = true
  }

  if (removed) await syncDirectory(directory)
}

export class DurableRunnerStore {
  #tail = Promise.resolve()

  constructor(stateDirectory) {
    this.root = stateDirectory
    this.statePath = join(stateDirectory, 'state.json')
    this.planDirectory = join(stateDirectory, 'plans')
    this.temporaryDirectory = join(stateDirectory, 'tmp')
  }

  async initialize() {
    await createPrivateDirectory(this.root)
    await createPrivateDirectory(this.planDirectory)
    await createPrivateDirectory(this.temporaryDirectory)
    await syncDirectory(this.root)
  }

  async read() {
    let source
    try {
      source = await readPrivateFile(this.statePath, maximumStateBytes)
    } catch (error) {
      if (error?.code === 'ENOENT') return createEmptyRunnerState()
      throw new Error('Agora runner state could not be read.')
    }

    try {
      return validateRunnerState(JSON.parse(source))
    } catch {
      throw new Error('Agora runner state is invalid.')
    }
  }

  update(mutator) {
    const operation = this.#tail.then(async () => {
      const state = await this.read()
      const result = await mutator(state)
      validateRunnerState(state)
      await atomicWrite(this.statePath, serialize(state))
      return result
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  async writePlan(plan) {
    validateDurablePlan(plan)
    const source = serialize(plan)
    await atomicWrite(join(this.planDirectory, `${plan.chunkId}.json`), source)
    return { actionCount: plan.messages.length, digest: digest(source) }
  }

  async readPlan(chunkId, expectedDigest) {
    let source
    try {
      source = await readPrivateFile(
        join(this.planDirectory, `${chunkId}.json`),
        maximumPlanBytes
      )
    } catch {
      throw new Error('Agora runner durable plan is unavailable.')
    }

    if (digest(source) !== expectedDigest) {
      throw new Error('Agora runner durable plan identity is invalid.')
    }

    try {
      const plan = validateDurablePlan(JSON.parse(source))
      if (plan.chunkId !== chunkId) throw new Error()
      return plan
    } catch {
      throw new Error('Agora runner durable plan is invalid.')
    }
  }

  async deletePlan(chunkId) {
    await rm(join(this.planDirectory, `${chunkId}.json`), { force: true })
    await syncDirectory(this.planDirectory)
  }

  handlerOutputPath(chunkId) {
    return join(this.temporaryDirectory, `${chunkId}-${randomUUID()}.json`)
  }

  async removeHandlerOutput(path) {
    await rm(path, { force: true })
  }

  async cleanupOrphanPlans(state) {
    const retained = new Set(Object.values(state.groups).flatMap((group) => (
      group.lease?.phase === 'planned' ? [`${group.lease.chunkId}.json`] : []
    )))
    const entries = await readdir(this.planDirectory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name) && !retained.has(entry.name)) {
        await rm(join(this.planDirectory, entry.name))
      }
    }
    await syncDirectory(this.planDirectory)
  }

  async cleanupInterruptedFiles() {
    const atomicPattern = /^\.agora-write-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i
    const outputPattern = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i
    await removeOwnedResidue(this.root, atomicPattern)
    await removeOwnedResidue(this.planDirectory, atomicPattern)
    await removeOwnedResidue(this.temporaryDirectory, atomicPattern)
    await removeOwnedResidue(this.temporaryDirectory, outputPattern)
  }
}
