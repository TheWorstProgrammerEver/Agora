import { createHash } from 'node:crypto'

export const opaqueLabel = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

export const createRunnerLogger = (write = (line) => process.stdout.write(line)) => ({
  event: (event, fields = {}) => {
    const record = {
      at: new Date().toISOString(),
      event,
      ...fields
    }
    write(`${JSON.stringify(record)}\n`)
  }
})

export const errorCodeFor = (error) => {
  if (typeof error?.code === 'string' && /^[a-z0-9_-]{1,64}$/.test(error.code)) {
    return error.code
  }
  return 'runner_failed'
}
