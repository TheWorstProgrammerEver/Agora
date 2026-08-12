import { opaqueLabel } from './redacted-log.mjs'

export const runnerStatus = (state) => ({
  groups: Object.entries(state.groups).map(([groupId, group]) => ({
    cursor: group.cursor,
    group: opaqueLabel(groupId),
    ...(group.lastHandledThrough ? { lastHandledThrough: group.lastHandledThrough } : {}),
    lease: group.lease
      ? {
          attempt: group.lease.attempt,
          expiresAt: group.lease.expiresAt,
          fromExclusive: group.lease.fromExclusive,
          phase: group.lease.phase,
          through: group.lease.through
        }
      : null,
    observedHighWatermark: group.observedHighWatermark
  })),
  lastActivity: state.lastActivity ?? null,
  principal: state.principalId ? opaqueLabel(state.principalId) : null,
  version: state.version
})
