import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { validateFingerprint } from './key-format.mjs'

const stateFilename = '.agora-agent-key.rotation.json'
const nextStateFilename = '.agora-agent-key.rotation.next.json'
const candidateNamePattern = /^\.agora-agent-key\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate\.cred$/
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const phases = new Set(['preparing', 'installing', 'staged', 'rolling-back', 'committing'])

const candidateNameFor = (operationId) => (
  `.agora-agent-key.${operationId}.candidate.cred`
)

const pathExists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

const assertPrivateFile = async (target, ownerUid) => {
  const metadata = await lstat(target)

  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== ownerUid
    || (metadata.mode & 0o777) !== 0o600
    || metadata.nlink !== 1
  ) {
    throw new Error('Credential rotation state has unsafe custody metadata.')
  }

  return metadata
}

const parseState = (serialized) => {
  let state

  try {
    state = JSON.parse(serialized)
  } catch {
    throw new Error('Credential rotation state is malformed.')
  }

  if (
    !state
    || Object.getPrototypeOf(state) !== Object.prototype
    || Object.keys(state).sort().join(',') !== 'candidateName,fingerprint,operationId,phase,version'
    || state.version !== 1
    || !operationIdPattern.test(state.operationId)
    || !phases.has(state.phase)
    || !candidateNamePattern.test(state.candidateName)
    || state.candidateName !== candidateNameFor(state.operationId)
  ) {
    throw new Error('Credential rotation state is malformed.')
  }

  return Object.freeze({
    ...state,
    fingerprint: validateFingerprint(state.fingerprint)
  })
}

export class CredentialRotationState {
  constructor({ directory, ownerUid, syncDirectory }) {
    this.directory = directory
    this.nextPath = path.join(directory, nextStateFilename)
    this.ownerUid = ownerUid
    this.statePath = path.join(directory, stateFilename)
    this.syncDirectory = syncDirectory
  }

  create(fingerprint) {
    const operationId = randomUUID()

    return Object.freeze({
      candidateName: candidateNameFor(operationId),
      fingerprint: validateFingerprint(fingerprint),
      operationId,
      phase: 'preparing',
      version: 1
    })
  }

  candidatePath(state) {
    const candidatePath = path.join(this.directory, state.candidateName)

    if (path.dirname(candidatePath) !== this.directory) {
      throw new Error('Credential rotation candidate escapes its trusted directory.')
    }

    return candidatePath
  }

  async read() {
    await this.discardUnpublishedState()

    if (!await pathExists(this.statePath)) {
      return undefined
    }

    const metadata = await assertPrivateFile(this.statePath, this.ownerUid)

    if (metadata.size > 1024) {
      throw new Error('Credential rotation state is malformed.')
    }

    return parseState(await readFile(this.statePath, 'utf8'))
  }

  async write(state, phase = state.phase) {
    const candidate = parseState(JSON.stringify({ ...state, phase }))
    await this.discardUnpublishedState()
    const handle = await open(
      this.nextPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    )

    try {
      await handle.writeFile(`${JSON.stringify(candidate)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await assertPrivateFile(this.nextPath, this.ownerUid)
    await rename(this.nextPath, this.statePath)
    await this.syncDirectory(this.directory)
    return candidate
  }

  async remove() {
    await this.discardUnpublishedState()

    if (!await pathExists(this.statePath)) {
      return
    }

    await assertPrivateFile(this.statePath, this.ownerUid)
    await unlink(this.statePath)
    await this.syncDirectory(this.directory)
  }

  async discardUnpublishedState() {
    if (!await pathExists(this.nextPath)) {
      return
    }

    await assertPrivateFile(this.nextPath, this.ownerUid)
    await unlink(this.nextPath)
    await this.syncDirectory(this.directory)
  }
}
