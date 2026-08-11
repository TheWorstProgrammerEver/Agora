import { createHash } from 'node:crypto'

export const applicationKeyPattern = /^agora_agent_v1_[A-Za-z0-9_-]{43}$/

export const fingerprintApplicationKey = (applicationKey) => (
  `sha256:${createHash('sha256').update(applicationKey).digest('hex').slice(0, 16)}`
)

export const validateApplicationKey = (applicationKey) => {
  if (!applicationKeyPattern.test(applicationKey)) {
    throw new Error('Agora agent key is malformed.')
  }

  return applicationKey
}

export const validateFingerprint = (fingerprint) => {
  if (!/^sha256:[a-f0-9]{16}$/.test(fingerprint)) {
    throw new Error('Agora agent key fingerprint is malformed.')
  }

  return fingerprint
}
