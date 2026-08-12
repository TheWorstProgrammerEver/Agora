import { describe, expect, it } from 'vitest'
import { parseGroupAvailabilityHint } from '../../../src/data/agora/groupAvailabilityPayload'

describe('group availability payloads', () => {
  it('accepts the persisted catch-up coordinates and ignores delivery metadata', () => {
    expect(parseGroupAvailabilityHint({
      groupId: '11111111-1111-4111-8111-111111111111',
      highWatermarkSequence: '42',
      id: 'opaque-delivery-id'
    })).toEqual({
      groupId: '11111111-1111-4111-8111-111111111111',
      highWatermarkSequence: '42'
    })
  })

  it.each([
    null,
    { groupId: 'group' },
    { groupId: 'group', highWatermarkSequence: -1 },
    { groupId: 'group', highWatermarkSequence: '-1' },
    { groupId: 'group', highWatermarkSequence: '01' }
  ])('rejects malformed availability payload %#', (payload) => {
    expect(parseGroupAvailabilityHint(payload)).toBeUndefined()
  })
})
