import { randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../../scripts/agent-keys/command.mjs'
import { fingerprintApplicationKey } from '../../scripts/agent-keys/key-format.mjs'
import { SystemdCredentialStore } from '../../scripts/agent-keys/systemd-credential-store.mjs'
import { createSystemdServiceControl } from '../../scripts/agent-keys/systemd-service.mjs'

if (process.getuid?.() !== 0) {
  throw new Error('The live systemd credential handoff test must run as root.')
}

const probePath = fileURLToPath(new URL('../fixtures/systemdCredentialProbe.mjs', import.meta.url))
const testRoot = await mkdtemp('/run/agora-agent-key-test-')
const directory = path.join(testRoot, 'credstore.encrypted')
const rawKeys = []
const observedFingerprints = []
let rejectNextValidation = false

const createKey = () => {
  const key = `agora_agent_v1_${randomBytes(32).toString('base64url')}`
  rawKeys.push(key)
  return key
}

const checkedRun = async (file, args, options) => {
  const serializedArgs = JSON.stringify(args)

  if (rawKeys.some((key) => serializedArgs.includes(key))) {
    throw new Error('A raw agent key entered a process argument.')
  }

  try {
    return await runCommand(file, args, options)
  } catch {
    const operation = args.find((value) => ['decrypt', 'encrypt'].includes(value))
      ?? path.basename(file)
    throw new Error(`Live ${operation} command failed.`)
  }
}

const probeActiveCredential = async () => {
  if (rejectNextValidation) {
    rejectNextValidation = false
    throw new Error('Controlled runner validation failure.')
  }

  const unit = `agora-agent-key-test-${randomUUID()}`
  const output = await checkedRun('/usr/bin/systemd-run', [
    '--wait',
    '--pipe',
    '--collect',
    '--quiet',
    `--unit=${unit}`,
    '--property=Type=oneshot',
    `--property=LoadCredentialEncrypted=agora-agent-key:${path.join(directory, 'agora-agent-key.cred')}`,
    process.execPath,
    probePath
  ], { output: 'buffer' })
  const fingerprint = output.toString('utf8').trim()

  if (!/^sha256:[a-f0-9]{16}$/.test(fingerprint)) {
    throw new Error('Systemd credential probe returned malformed evidence.')
  }

  observedFingerprints.push(fingerprint)

  const bindingUnit = `${unit}-binding.service`
  const credentialFile = path.join(directory, 'agora-agent-key.cred')

  try {
    await checkedRun('/usr/bin/systemd-run', [
      '--no-block',
      '--quiet',
      `--unit=${bindingUnit}`,
      '--property=Type=simple',
      `--property=LoadCredentialEncrypted=agora-agent-key:${credentialFile}`,
      '/bin/sleep',
      '30'
    ])
    const service = createSystemdServiceControl({
      expectedCredentialPath: credentialFile,
      run: checkedRun,
      service: bindingUnit
    })

    await service.restartAndValidate()
  } finally {
    await runCommand('/usr/bin/systemctl', ['stop', bindingUnit]).catch(() => {})
    await runCommand('/usr/bin/systemctl', ['reset-failed', bindingUnit]).catch(() => {})
  }
}

const assertNoRawCredentialFile = async () => {
  for (const filename of await readdir(directory)) {
    const content = await readFile(path.join(directory, filename))

    if (rawKeys.some((key) => content.includes(key))) {
      throw new Error('A raw agent key was persisted to the credential store.')
    }
  }
}

const syncDirectory = async () => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const store = new SystemdCredentialStore({
  directory,
  ownerUid: 0,
  run: checkedRun,
  trustedRoot: '/run',
  validateActive: probeActiveCredential,
  withKey: 'null'
})

try {
  const original = createKey()
  const replacement = createKey()
  const rejectedReplacement = createKey()
  const originalFingerprint = fingerprintApplicationKey(original)
  const replacementFingerprint = fingerprintApplicationKey(replacement)

  await store.install(Buffer.from(original), originalFingerprint)
  await assertNoRawCredentialFile()

  for (const checkpoint of ['old-renamed', 'replacement-renamed', 'replacement-durable']) {
    const interruptedReplacement = createKey()
    let state = store.rotationState.create(
      fingerprintApplicationKey(interruptedReplacement)
    )
    state = await store.rotationState.write(state)
    const candidatePath = store.rotationState.candidatePath(state)
    const secret = Buffer.from(interruptedReplacement)

    try {
      await store.sealCandidate(secret, state.fingerprint, candidatePath)
    } finally {
      secret.fill(0)
    }
    await store.rotationState.write(state, 'installing')
    await rename(store.activePath, store.rollbackPath)

    if (checkpoint !== 'old-renamed') {
      await syncDirectory()
      await rename(candidatePath, store.activePath)
    }

    if (checkpoint === 'replacement-durable') {
      await syncDirectory()
    }

    await store.rollbackRotation()

    if (observedFingerprints.at(-1) !== originalFingerprint) {
      throw new Error(`Interrupted rotation recovery failed at ${checkpoint}.`)
    }
  }

  rejectNextValidation = true
  await store.rotate(
    Buffer.from(rejectedReplacement),
    fingerprintApplicationKey(rejectedReplacement)
  ).then(
    () => { throw new Error('Controlled rotation failure unexpectedly succeeded.') },
    (error) => {
      if (error.message !== 'Controlled runner validation failure.') {
        throw error
      }
    }
  )

  if (observedFingerprints.at(-1) !== originalFingerprint) {
    throw new Error('Failed rotation did not restore the original systemd credential.')
  }

  await store.rotate(Buffer.from(replacement), replacementFingerprint)
  await assertNoRawCredentialFile()

  if (observedFingerprints.at(-1) !== replacementFingerprint) {
    throw new Error('Replacement was not delivered through CREDENTIALS_DIRECTORY.')
  }

  await store.rollbackRotation()

  if (observedFingerprints.at(-1) !== originalFingerprint) {
    throw new Error('Rollback did not restore the original systemd credential.')
  }

  await store.rotate(Buffer.from(replacement), replacementFingerprint)
  await store.commitRotation()
  await assertNoRawCredentialFile()
  await store.revoke()

  if ((await readdir(directory)).length !== 0) {
    throw new Error('Revocation left an encrypted credential artifact behind.')
  }

  process.stdout.write('Systemd encrypted-credential install, rotation, rollback, commit, and revocation passed.\n')
} finally {
  rawKeys.fill('[cleared]')
  await rm(testRoot, { force: true, recursive: true })
}
