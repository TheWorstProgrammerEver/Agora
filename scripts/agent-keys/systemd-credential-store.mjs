import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
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

const syncDirectory = async (directory) => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

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

export class SystemdCredentialStore {
  constructor({
    directory = credentialDirectory,
    ownerUid = 0,
    run = runCommand,
    trustedRoot = '/',
    validateActive = async () => {},
    withKey = 'host'
  } = {}) {
    this.activePath = path.join(directory, `${credentialName}.cred`)
    this.directory = directory
    this.ownerUid = ownerUid
    this.rollbackPath = path.join(directory, `.${credentialName}.rollback.cred`)
    this.run = run
    this.trustedRoot = trustedRoot
    this.validateActive = validateActive

    if (!['host', 'null'].includes(withKey)) {
      throw new Error('Unsupported systemd credential encryption key mode.')
    }

    this.withKey = withKey
  }

  async prepare() {
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
    await this.prepare()

    if (await pathExists(this.activePath) || await pathExists(this.rollbackPath)) {
      throw new Error('An encrypted Agora agent credential already exists.')
    }

    const candidate = await this.sealCandidate(applicationKey, expectedFingerprint)

    try {
      await rename(candidate.path, this.activePath)
      await syncDirectory(this.directory)
      await this.validateActive({ fingerprint: candidate.fingerprint, path: this.activePath })
      return candidate.fingerprint
    } catch (error) {
      await this.removeIfPresent(this.activePath)
      await this.removeIfPresent(candidate.path)
      throw error
    }
  }

  async rotate(applicationKey, expectedFingerprint) {
    await this.prepare()
    await assertProtectedCredential(this.activePath, this.ownerUid)

    if (await pathExists(this.rollbackPath)) {
      throw new Error('A previous encrypted credential is still awaiting commit or rollback.')
    }

    const candidate = await this.sealCandidate(applicationKey, expectedFingerprint)

    try {
      await rename(this.activePath, this.rollbackPath)
      await rename(candidate.path, this.activePath)
      await syncDirectory(this.directory)
      await this.validateActive({ fingerprint: candidate.fingerprint, path: this.activePath })
      return candidate.fingerprint
    } catch (error) {
      if (await pathExists(this.rollbackPath)) {
        await this.removeIfPresent(this.activePath)
        await rename(this.rollbackPath, this.activePath)
        await syncDirectory(this.directory)
        await this.validateActive({ path: this.activePath })
      }
      await this.removeIfPresent(candidate.path)
      throw error
    }
  }

  async commitRotation() {
    await this.prepare()
    await assertProtectedCredential(this.activePath, this.ownerUid)
    await assertProtectedCredential(this.rollbackPath, this.ownerUid)
    await unlink(this.rollbackPath)
    await syncDirectory(this.directory)
  }

  async rollbackRotation() {
    await this.prepare()
    await assertProtectedCredential(this.activePath, this.ownerUid)
    await assertProtectedCredential(this.rollbackPath, this.ownerUid)
    const replacementPath = path.join(
      this.directory,
      `.${credentialName}.${randomUUID()}.replacement.cred`
    )
    let activeMoved = false
    let rollbackMoved = false

    try {
      await rename(this.activePath, replacementPath)
      activeMoved = true
      await rename(this.rollbackPath, this.activePath)
      rollbackMoved = true
      await syncDirectory(this.directory)
      await this.validateActive({ path: this.activePath })
      await unlink(replacementPath)
      await syncDirectory(this.directory)
    } catch (error) {
      if (rollbackMoved && await pathExists(this.activePath)) {
        await rename(this.activePath, this.rollbackPath)
      }
      if (activeMoved && await pathExists(replacementPath)) {
        await rename(replacementPath, this.activePath)
      }
      await syncDirectory(this.directory)
      if (await pathExists(this.activePath)) {
        await this.validateActive({ path: this.activePath })
      }
      throw error
    }
  }

  async revoke(stopService = async () => {}) {
    await this.prepare()
    let stopError

    try {
      await stopService()
    } catch (error) {
      stopError = error
    }

    await this.removeIfPresent(this.activePath)
    await this.removeIfPresent(this.rollbackPath)

    if (stopError) {
      throw stopError
    }
  }

  async sealCandidate(applicationKey, expectedFingerprint) {
    const keyText = validateApplicationKey(applicationKey.toString('utf8'))
    const fingerprint = fingerprintApplicationKey(keyText)

    if (fingerprint !== validateFingerprint(expectedFingerprint)) {
      throw new Error('Agora agent key does not match the expected fingerprint.')
    }

    const candidatePath = path.join(
      this.directory,
      `.${credentialName}.${randomUUID()}.candidate.cred`
    )

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

      return { fingerprint, path: candidatePath }
    } catch (error) {
      await this.removeCandidateIfPresent(candidatePath)
      throw error
    }
  }

  async removeIfPresent(target) {
    if (!await pathExists(target)) {
      return
    }

    await assertProtectedCredential(target, this.ownerUid)
    await unlink(target)
    await syncDirectory(this.directory)
  }

  async removeCandidateIfPresent(target) {
    if (!await pathExists(target)) {
      return
    }

    assertContained(this.directory, target)
    const metadata = await lstat(target)

    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== this.ownerUid) {
      throw new Error('Operation-owned credential candidate has unsafe metadata.')
    }

    await unlink(target)
    await syncDirectory(this.directory)
  }
}
