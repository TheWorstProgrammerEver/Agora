export const runnerStateVersion = 1
export const handlerPlanVersion = 1
export const maximumHandlerActions = 4
export const maximumGroupPages = 100
export const maximumChunkSize = 50
export const maximumApiResponseBytes = 1024 * 1024
export const credentialName = 'agora-agent-key'
export const agentKeyPattern = /^agora_agent_v1_[A-Za-z0-9_-]{43}$/
export const agentKeySearchPattern = /agora_agent_v1_[A-Za-z0-9_-]{43}/
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const sequencePattern = /^(?:0|[1-9]\d*)$/
export const positiveSequencePattern = /^[1-9]\d*$/

export const handlerFailureCodes = new Set([
  'canceled',
  'handler_failed',
  'handler_output_invalid',
  'handler_timeout',
  'range_unavailable'
])
