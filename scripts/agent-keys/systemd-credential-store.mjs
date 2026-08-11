import { constants as fsConstants } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import { withRuntimeStateCoordinator } from '../runtime-state-coordinator.mjs'
import { CredentialRotationState } from './credential-rotation-state.mjs'
import { runCommand } from './command.mjs'
import {
  fingerprintApplicationKey,
  validateApplicationKey,
  validateFingerprint
} from './key-format.mjs'

export const credentialName = 'agora-agent-key'
export const credentialDirectory = '/etc/credstore.encrypted'
export const credentialPath = `${credentialDirectory}/${credentialName}.cred`

const systemdCredsPath = '/usr/bin/systemd-creds'
const encryptedArtifactPattern = /^\.agora-agent-key\.[0-9a-f-]+\.(candidate|replacement)\.cred$/

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

const syncPath = async (target, flags) => {
  const handle = await open(target, flags)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectory = (directory) => syncPath(
  directory,
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY
)

const syncFile = (target) => syncPath(target, fsConstants.O_RDONLY)

const assertContained = (trustedRoot, target) => {
  const relative = path.relative(trustedRoot, target)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Credential path escapes its trusted root.')
  }
}

const assertProtectedDirectory = async (trustedRoot, directory, ownerUid) => {
  assertContained(trustedRoot, directory)
  const relativeParts = path.relative(trustedRoot, directory).split(path.sep).filter(Boolean)
  let current = trustedRoot

  for (const part of ['', ...relativeParts]) {
    current = part ? path.join(current, part) : current
    const metadata = await lstat(current)

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Credential directory ancestry is not trusted.')
    }

    if (metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0) {
      throw new Error('Credential directory ancestry has unsafe ownership or permissions.')
    }
  }
}

const assertProtectedCredential = async (target, ownerUid) => {
  const metadata = await lstat(target)

  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== ownerUid
    || (metadata.mode & 0o777) !== 0o600
    || metadata.nlink !== 1
  ) {
    throw new Error('Encrypted credential has unsafe custody metadata.')
  }
}

const validateCandidateInput = (applicationKey, expectedFingerprint) => {
  const keyText = validateApplicationKey(applicationKey.toString('utf8'))
  const fingerprint = fingerprintApplicationKey(keyText)

  if (fingerprint !== validateFingerprint(expectedFingerprint)) {
    throw new Error('Agora agent key does not match the expected fingerprint.')
  }

  return fingerprint
}

export class SystemdCredentialStore {
  #coordinateMutation

  constructor({
    directory = credentialDirectory,
    ownerUid = 0,
    run = runCommand,
    trustedRoot = '/',
    validateActive = async () => {},
    coordinatorOptions,
    withKey = 'host'
  } = {}) {
    this.activePath = path.join(directory, `${credentialName}.cred`)
    this.directory = directory
    this.ownerUid = ownerUid
    this.rollbackPath = path.join(directory, `.${credentialName}.rollback.cred`)
    this.rotationState = new CredentialRotationState({
      directory,
      ownerUid,
      syncDirectory
    })
    this.run = run
    this.trustedRoot = trustedRoot
    this.validateActive = validateActive
    this.#coordinateMutation = (operation) => (
      withRuntimeStateCoordinator(
        `agora-agent-credential:${this.activePath}`,
        operation,
        {
          ...coordinatorOptions,
          busyMessage: 'Agora agent credential store is busy; retry the host credential command.'
        }
      )
    )

    if (!['host', 'null'].includes(withKey)) {
      throw new Error('Unsupported systemd credential encryption key mode.')
    }

    this.withKey = withKey
  }

  async #prepareWhileLocked() {
    assertContained(this.trustedRoot, this.directory)

    if (!await pathExists(this.directory)) {
      await assertProtectedDirectory(
        this.trustedRoot,
        path.dirname(this.directory),
        this.ownerUid
      )
      await mkdir(this.directory, { mode: 0o700 })
      await syncDirectory(path.dirname(this.directory))
    }

    await assertProtectedDirectory(this.trustedRoot, this.directory, this.ownerUid)
    const metadata = await lstat(this.directory)

    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error('Credential directory must have mode 0700.')
    }
  }

  async install(applicationKey, expectedFingerprint) {
    return this.#coordinateMutation(
      () => this.#installWhileLocked(applicationKey, expectedFingerprint)
    )
  }

  async #installWhileLocked(applicationKey, expectedFingerprint) {
    const fingerprint = validateCandidateInput(applicationKey, expectedFingerprint)
    await this.#prepareWhileLocked()

    if (
      await pathExists(this.activePath)
      || await pathExists(this.rollbackPath)
      || await this.rotationState.read()
    ) {
      throw new Error('An encrypted Agora agent credential already exists.')
    }

    const candidatePath = path.join(
      this.directory,
      `.${credentialName}.install.candidate.cred`
    )

    if (await pathExists(candidatePath)) {
      throw new Error('An interrupted encrypted credential installation requires operator recovery.')
    }

    try {
      await this.#sealCandidate(applicationKey, fingerprint, candidatePath)
      await rename(candidatePath, this.activePath)
      await syncDirectory(this.directory)
      await this.validateActive({ fingerprint, path: this.activePath })
      return fingerprint
    } catch (error) {
      await this.#removeIfPresent(this.activePath)
      await this.#removeCandidateIfPresent(candidatePath)
      throw error
    }
  }

  async rotate(applicationKey, expectedFingerprint) {
    return this.#coordinateMutation(
      () => this.#rotateWhileLocked(applicationKey, expectedFingerprint)
    )
  }

  async #rotateWhileLocked(applicationKey, expectedFingerprint) {
    const fingerprint = validateCandidateInput(applicationKey, expectedFingerprint)
    await this.#prepareWhileLocked()
    await this.#reconcileBeforeRotation()
    await assertProtectedCredential(this.activePath, this.ownerUid)

    if (await pathExists(this.rollbackPath)) {
      throw new Error('A previous encrypted credential is still awaiting commit or rollback.')
    }

    let state = this.rotationState.create(fingerprint)

    try {
      state = await this.rotationState.write(state)
      const candidatePath = this.rotationState.candidatePath(state)
      await this.#sealCandidate(applicationKey, fingerprint, candidatePath)
      state = await this.rotationState.write(state, 'installing')
      await rename(this.activePath, this.rollbackPath)
      await syncDirectory(this.directory)
      await rename(candidatePath, this.activePath)
      await syncDirectory(this.directory)
      await this.validateActive({ fingerprint, path: this.activePath })
      await this.rotationState.write(state, 'staged')
      return fingerprint
    } catch (error) {
      try {
        const currentState = await this.rotationState.read()

        if (currentState && ['preparing', 'installing', 'rolling-back'].includes(currentState.phase)) {
          await this.#recoverOriginal(currentState)
        }
      } catch {
        throw new Error('Credential rotation failed and requires an explicit rollback recovery.')
      }

      throw error
    }
  }

  async commitRotation() {
    return this.#coordinateMutation(() => this.#commitRotationWhileLocked())
  }

  async #commitRotationWhileLocked() {
    await this.#prepareWhileLocked()
    let state = await this.rotationState.read()

    if (!state) {
      throw new Error('No encrypted credential rotation is awaiting commit.')
    }

    if (['preparing', 'installing', 'rolling-back'].includes(state.phase)) {
      throw new Error('Interrupted credential rotation must be rolled back with service validation.')
    }

    if (state.phase === 'staged') {
      await assertProtectedCredential(this.activePath, this.ownerUid)
      await assertProtectedCredential(this.rollbackPath, this.ownerUid)
      state = await this.rotationState.write(state, 'committing')
    }

    await this.#finishCommit(state)
  }

  async rollbackRotation() {
    return this.#coordinateMutation(() => this.#rollbackRotationWhileLocked())
  }

  async #rollbackRotationWhileLocked() {
    await this.#prepareWhileLocked()
    const state = await this.rotationState.read()

    if (!state) {
      if (!await pathExists(this.activePath) && await pathExists(this.rollbackPath)) {
        await assertProtectedCredential(this.rollbackPath, this.ownerUid)
        await rename(this.rollbackPath, this.activePath)
        await syncDirectory(this.directory)
        await this.validateActive({ path: this.activePath })
        return
      }

      throw new Error('No encrypted credential rotation is awaiting rollback.')
    }

    if (state.phase === 'committing') {
      throw new Error('Credential rotation commit is already in progress; rollback is denied.')
    }

    const rollbackState = state.phase === 'staged'
      ? await this.rotationState.write(state, 'rolling-back')
      : state

    await this.#recoverOriginal(rollbackState)
  }

  async revoke(stopService = async () => {}) {
    return this.#coordinateMutation(() => this.#revokeWhileLocked(stopService))
  }

  async #revokeWhileLocked(stopService) {
    await this.#prepareWhileLocked()
    let stopError

    try {
      await stopService()
    } catch (error) {
      stopError = error
    }

    for (const filename of await readdir(this.directory)) {
      const target = path.join(this.directory, filename)

      if (
        target === this.activePath
        || target === this.rollbackPath
        || filename === `.${credentialName}.install.candidate.cred`
        || encryptedArtifactPattern.test(filename)
      ) {
        await this.#removeIfPresent(target)
      }
    }

    await this.rotationState.remove()

    if (stopError) {
      throw stopError
    }
  }

  async #reconcileBeforeRotation() {
    const state = await this.rotationState.read()

    if (!state) {
      return
    }

    if (['preparing', 'installing', 'rolling-back'].includes(state.phase)) {
      await this.#recoverOriginal(state)
      return
    }

    if (state.phase === 'committing') {
      await this.#finishCommit(state)
      return
    }

    throw new Error('A previous encrypted credential is still awaiting commit or rollback.')
  }

  async #recoverOriginal(state) {
    const candidatePath = this.rotationState.candidatePath(state)
    const activeExists = await pathExists(this.activePath)
    const rollbackExists = await pathExists(this.rollbackPath)
    const candidateExists = await pathExists(candidatePath)

    if (state.phase === 'preparing') {
      if (!activeExists || rollbackExists) {
        throw new Error('Interrupted credential rotation has inconsistent protected state.')
      }
    } else if (rollbackExists && activeExists && candidateExists) {
      throw new Error('Interrupted credential rotation has ambiguous protected state.')
    } else if (rollbackExists) {
      if (activeExists) {
        await rename(this.activePath, candidatePath)
        await syncDirectory(this.directory)
      }

      await rename(this.rollbackPath, this.activePath)
      await syncDirectory(this.directory)
    } else if (!activeExists) {
      throw new Error('Interrupted credential rotation cannot recover the original credential.')
    }

    await assertProtectedCredential(this.activePath, this.ownerUid)
    await this.validateActive({ path: this.activePath })
    await this.#removeCandidateIfPresent(candidatePath)
    await this.rotationState.remove()
  }

  async #finishCommit(state) {
    if (state.phase !== 'committing') {
      throw new Error('Credential rotation state cannot be committed.')
    }

    await assertProtectedCredential(this.activePath, this.ownerUid)
    await this.#removeIfPresent(this.rollbackPath)
    await this.#removeCandidateIfPresent(this.rotationState.candidatePath(state))
    await this.rotationState.remove()
  }

  async #sealCandidate(applicationKey, fingerprint, candidatePath) {
    try {
      await this.run(systemdCredsPath, [
        ...(this.withKey === 'null' ? ['--allow-null'] : []),
        `--with-key=${this.withKey}`,
        '--newline=no',
        `--name=${credentialName}`,
        'encrypt',
        '-',
        candidatePath
      ], { input: applicationKey })
      await chmod(candidatePath, 0o600)
      await assertProtectedCredential(candidatePath, this.ownerUid)
      await syncFile(candidatePath)
      await syncDirectory(this.directory)

      const decrypted = await this.run(systemdCredsPath, [
        ...(this.withKey === 'null' ? ['--allow-null'] : []),
        '--newline=no',
        `--name=${credentialName}`,
        'decrypt',
        candidatePath,
        '-'
      ], { output: 'buffer' })

      try {
        const expectedDigest = createHash('sha256').update(applicationKey).digest()
        const decryptedDigest = createHash('sha256').update(decrypted).digest()

        if (!timingSafeEqual(decryptedDigest, expectedDigest)) {
          throw new Error('Encrypted credential validation failed.')
        }
      } finally {
        decrypted.fill(0)
      }

      return fingerprint
    } catch (error) {
      await this.#removeCandidateIfPresent(candidatePath)
      throw error
    }
  }

  async #removeIfPresent(target) {
    if (!await pathExists(target)) {
      return
    }

    await assertProtectedCredential(target, this.ownerUid)
    await unlink(target)
    await syncDirectory(this.directory)
  }

  async #removeCandidateIfPresent(target) {
    if (!await pathExists(target)) {
      return
    }

    assertContained(this.directory, target)
    await assertProtectedCredential(target, this.ownerUid)
    await unlink(target)
    await syncDirectory(this.directory)
  }
}
