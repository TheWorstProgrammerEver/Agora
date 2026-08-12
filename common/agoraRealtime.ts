export const agoraRealtimeEvent = 'message_available' as const
export const agoraRealtimeTopicPrefix = 'agora:group:' as const
export const agoraRealtimeAgentRole = 'agora_realtime_agent' as const

export const maximumRealtimeTopicsPerSession = 32
export const realtimeSessionLifetimeSeconds = 5 * 60
export const realtimeSessionRefreshLeadSeconds = 60

export const formatAgoraRealtimeTopic = (groupId: string) => (
  `${agoraRealtimeTopicPrefix}${groupId}`
)
