const safeToken = /^[a-z0-9][a-z0-9_.:@/-]{0,255}$/i

export class ProvisioningFailure extends Error {
  constructor({ code, recovery, stage }) {
    super(code)
    this.code = requireSafe(code, 'failure code')
    this.recovery = requireRecovery(recovery)
    this.stage = requireSafe(stage, 'failure stage')
  }
}

const requireSafe = (value, label) => {
  if (!safeToken.test(value)) throw new Error(`Provisioning ${label} is invalid.`)
  return value
}

const requireRecovery = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || /[\r\n]/.test(value)) {
    throw new Error('Provisioning recovery command is invalid.')
  }

  return value
}

export const asProvisioningFailure = (error, fallback) => (
  error instanceof ProvisioningFailure
    ? error
    : new ProvisioningFailure(fallback)
)

export const writeProvisioningFailure = (error, fallback, write = process.stderr.write.bind(process.stderr)) => {
  const failure = asProvisioningFailure(error, fallback)
  write(`${JSON.stringify({
    code: failure.code,
    event: 'provisioning_failed',
    recovery: failure.recovery,
    stage: failure.stage
  })}\n`)
}

export const fail = (stage, code, recovery) => {
  throw new ProvisioningFailure({ code, recovery, stage })
}
