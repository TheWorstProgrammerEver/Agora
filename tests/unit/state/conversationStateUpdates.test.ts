import { describe, expect, it } from 'vitest'
import type { MessageDto } from '../../../common/agoraDtos'
import {
  compareMessageSequences,
  isMessageUnread,
  laterSequence,
  mergeMessages,
  sequenceBefore
} from '../../../src/state/conversationStateUpdates'

const message = (id: string, sequence: string, text = `Message ${sequence}`): MessageDto => ({
  createdAt: '2026-08-12T00:00:00Z',
  groupId: '11111111-1111-4111-8111-111111111111',
  id,
  sender: {
    displayName: 'Human Member',
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'human'
  },
  sequence,
  text
})

describe('conversation UI state updates', () => {
  it('orders persisted pages and deduplicates replayed sequences', () => {
    const first = message('33333333-3333-4333-8333-333333333333', '1')
    const second = message('44444444-4444-4444-8444-444444444444', '2')
    const replayedSecond = { ...second, text: 'Persisted replay' }
    const third = message('55555555-5555-4555-8555-555555555555', '3')

    expect(mergeMessages([second, third], [first, replayedSecond])).toEqual([
      first,
      replayedSecond,
      third
    ])
  })

  it('compares sequence strings without lossy number conversion', () => {
    const huge = '900719925474099300000'

    expect(compareMessageSequences(huge, '900719925474099299999')).toBe(1)
    expect(laterSequence('4', huge)).toBe(huge)
    expect(sequenceBefore(huge)).toBe('900719925474099299999')
  })

  it('derives unread state from the acknowledged sequence', () => {
    expect(isMessageUnread(message('66666666-6666-4666-8666-666666666666', '8'), '7')).toBe(true)
    expect(isMessageUnread(message('77777777-7777-4777-8777-777777777777', '7'), '7')).toBe(false)
  })
})
