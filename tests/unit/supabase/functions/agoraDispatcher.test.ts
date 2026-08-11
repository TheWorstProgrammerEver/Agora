import { describe, expect, it } from 'vitest'
import { agoraRequestIdentifiers } from '../../../../common/agoraRequestIdentifiers'
import { createAgoraDispatcher } from '../../../../supabase/functions/agora/dispatcher'

describe('Agora Edge dispatcher foundation', () => {
  it('has no product handlers yet', async () => {
    const dispatcher = createAgoraDispatcher()

    await expect(dispatcher.dispatch({
      identifier: agoraRequestIdentifiers.listGroups,
      params: {}
    })).rejects.toThrow('Unsupported request listGroups')
  })
})
