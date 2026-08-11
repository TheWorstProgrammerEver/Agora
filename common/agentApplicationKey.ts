export const agentApplicationKeyHeader = 'x-agora-agent-key'
export const agentApplicationKeyPattern = /^agora_agent_v1_[A-Za-z0-9_-]{43}$/

export const isAgentApplicationKey = (value: unknown): value is string => (
  typeof value === 'string' && agentApplicationKeyPattern.test(value)
)
