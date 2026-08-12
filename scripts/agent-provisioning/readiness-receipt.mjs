import { createHash } from 'node:crypto'

const prefix = 'agora_host_ready_v1'
const maximumAgeMs = 15 * 60 * 1000
const receiptPattern = /^agora_host_ready_v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/
const servicePattern = /^agora-agent-runner@[a-z_][a-z0-9_-]{0,30}\.service$/
const digestPattern = /^[a-f0-9]{64}$/
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

const digest = (value) => createHash('sha256').update(value).digest('hex')

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

const decode = (value) => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Host readiness receipt is malformed.')
  }
}

const validatePayload = (payload, now) => {
  if (
    !payload
    || Object.keys(payload).sort().join(',') !== 'agentPrincipalId,artifactDigest,checkedAt,operation,service,version'
    || payload.version !== 1
    || !uuidPattern.test(payload.agentPrincipalId)
    || !digestPattern.test(payload.artifactDigest)
    || !servicePattern.test(payload.service)
    || !['install', 'recover', 'rotate'].includes(payload.operation)
    || !Number.isSafeInteger(payload.checkedAt)
    || payload.checkedAt > now
    || now - payload.checkedAt > maximumAgeMs
  ) {
    throw new Error('Host readiness receipt is invalid or expired.')
  }

  return payload
}

export const createReadinessReceipt = ({ agentPrincipalId, artifactDigest, now = Date.now(), operation, service }) => {
  const encoded = encode(validatePayload({
    agentPrincipalId: agentPrincipalId.toLowerCase(),
    artifactDigest,
    checkedAt: now,
    operation,
    service,
    version: 1
  }, now))

  return `${prefix}.${encoded}.${digest(`${prefix}.${encoded}`)}`
}

export const parseReadinessReceipt = (receipt, now = Date.now()) => {
  const match = receiptPattern.exec(receipt)
  if (!match || digest(`${prefix}.${match[1]}`) !== match[2]) {
    throw new Error('Host readiness receipt is malformed.')
  }

  return validatePayload(decode(match[1]), now)
}
