import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgoraRequestResult } from '../../../common/agoraRequestContract'
import { agoraRequestIdentifiers } from '../../../common/agoraRequestIdentifiers'
import {
  maximumClientMessageIdLength,
  maximumMessageTextLength
} from '../../../common/agoraMessageLimits'
import {
  cleanupGroupLifecycleFixtures,
  createGroup,
  createGroupLifecycleFixtures,
  groupLifecycleAdmin as admin,
  insertMembership,
  postAgent,
  postHuman,
  selectCount,
  type GroupLifecycleFixtures
} from './groupLifecycleTestSupport'
import { createAnonymousClient } from './localSupabase'

let fixtures: GroupLifecycleFixtures | undefined

const requireFixtures = () => {
  if (!fixtures) {
    throw new Error('Message security fixtures were not created.')
  }

  return fixtures
}

const removeGroup = async (groupId: string) => {
  const { error } = await admin.from('groups').delete().eq('id', groupId)

  if (error) {
    throw error
  }
}

beforeAll(async () => {
  fixtures = await createGroupLifecycleFixtures()
})

afterAll(async () => {
  await cleanupGroupLifecycleFixtures(fixtures)
})

describe('append-only message command and RLS boundary', () => {
  it('derives human and agent authors and scopes idempotency to sender and group', async () => {
    const { agent, member, owner } = requireFixtures()
    const firstGroup = await createGroup(owner, 'Message authorship group')
    const secondGroup = await createGroup(owner, 'Message idempotency scope group')

    try {
      await insertMembership(firstGroup.id, member.principalId)
      await insertMembership(firstGroup.id, agent.principalId)

      const ownerSend = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: firstGroup.id,
        text: 'Owner message'
      })
      const ownerRetry = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: firstGroup.id,
        text: 'Owner message'
      })
      const memberSend = await postHuman(member, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: firstGroup.id,
        text: 'Member message'
      })
      const agentSend = await postAgent(agent, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: firstGroup.id,
        text: 'Agent message'
      })
      const secondGroupSend = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: secondGroup.id,
        text: 'Same sender and key, different group'
      })

      expect(ownerSend.status).toBe(200)
      expect(ownerRetry).toEqual(ownerSend)
      expect(memberSend.status).toBe(200)
      expect(agentSend.status).toBe(200)
      expect(secondGroupSend.status).toBe(200)

      const messages = [ownerSend, memberSend, agentSend].map(({ body }) => (
        body as AgoraRequestResult<'sendMessage'>
      ))

      expect(messages.map(({ sender }) => sender)).toEqual([
        expect.objectContaining({ id: owner.principalId, kind: 'human' }),
        expect.objectContaining({ id: member.principalId, kind: 'human' }),
        expect.objectContaining({ id: agent.principalId, kind: 'agent' })
      ])
      expect(messages.map(({ sequence }) => sequence)).toEqual(['1', '2', '3'])
      expect(messages.every(({ createdAt, groupId }) => (
        groupId === firstGroup.id && !Number.isNaN(Date.parse(createdAt))
      ))).toBe(true)
      expect(new Set([
        ...messages.map(({ id }) => id),
        (secondGroupSend.body as AgoraRequestResult<'sendMessage'>).id
      ]).size).toBe(4)
      expect((secondGroupSend.body as AgoraRequestResult<'sendMessage'>).sequence).toBe('1')

      const conflictingRetry = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'shared-client-id',
        groupId: firstGroup.id,
        text: 'Changed text'
      })

      expect(conflictingRetry).toEqual({
        body: { error: 'This client message identifier is already in use.' },
        status: 409
      })
      const [oversizedClientId, oversizedText, blankClientId, blankText] = await Promise.all([
        owner.client.rpc('send_agora_message', {
          client_message_id_to_use: 'i'.repeat(maximumClientMessageIdLength + 1),
          group_id_to_use: firstGroup.id,
          message_text_to_use: 'Valid text'
        }),
        owner.client.rpc('send_agora_message', {
          client_message_id_to_use: 'oversized-text',
          group_id_to_use: firstGroup.id,
          message_text_to_use: 'x'.repeat(maximumMessageTextLength + 1)
        }),
        owner.client.rpc('send_agora_message', {
          client_message_id_to_use: '\t\n',
          group_id_to_use: firstGroup.id,
          message_text_to_use: 'Valid text'
        }),
        owner.client.rpc('send_agora_message', {
          client_message_id_to_use: 'blank-text',
          group_id_to_use: firstGroup.id,
          message_text_to_use: '\t\n'
        })
      ])

      expect(oversizedClientId.error?.code).toBe('22023')
      expect(oversizedText.error?.code).toBe('22023')
      expect(blankClientId.error?.code).toBe('22023')
      expect(blankText.error?.code).toBe('22023')
      await expect(Promise.all([
        selectCount('messages', 'group_id', firstGroup.id),
        selectCount('message_idempotency_keys', 'group_id', firstGroup.id, 'message_id')
      ])).resolves.toEqual([3, 3])
    } finally {
      await Promise.all([removeGroup(firstGroup.id), removeGroup(secondGroup.id)])
    }
  })

  it('denies pending, removed, anonymous, and cross-group principals on every direct boundary', async () => {
    const { agent, member, outsider, owner } = requireFixtures()
    const privateGroup = await createGroup(owner, 'Private message group')
    const outsiderGroup = await createGroup(outsider, 'Outsider message group')

    try {
      await insertMembership(privateGroup.id, member.principalId)
      await insertMembership(privateGroup.id, agent.principalId)
      await postHuman(owner, agoraRequestIdentifiers.inviteHuman, {
        email: outsider.email,
        groupId: privateGroup.id
      })
      const privateSend = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'private-message',
        groupId: privateGroup.id,
        text: 'Members only'
      })
      const outsiderSend = await postHuman(outsider, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'outsider-message',
        groupId: outsiderGroup.id,
        text: 'Outsider group only'
      })

      expect(privateSend.status).toBe(200)
      expect(outsiderSend.status).toBe(200)

      const [ownerRows, memberRows, agentRows, outsiderRows, anonymousRows] = await Promise.all([
        owner.client.from('messages').select('id, group_id').order('sequence'),
        member.client.from('messages').select('id, group_id').order('sequence'),
        agent.client.from('messages').select('id, group_id').order('sequence'),
        outsider.client.from('messages').select('id, group_id').order('sequence'),
        createAnonymousClient().from('messages').select('id, group_id').order('sequence')
      ])

      expect(ownerRows.error).toBeNull()
      expect(ownerRows.data).toEqual([expect.objectContaining({ group_id: privateGroup.id })])
      expect(memberRows.data).toEqual(ownerRows.data)
      expect(agentRows.data).toEqual(ownerRows.data)
      expect(outsiderRows.data).toEqual([expect.objectContaining({ group_id: outsiderGroup.id })])
      expect(anonymousRows.data).toEqual([])

      const [pendingSend, crossGroupAgentSend] = await Promise.all([
        postHuman(outsider, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'pending-denied',
          groupId: privateGroup.id,
          text: 'Denied while pending'
        }),
        postAgent(agent, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: 'cross-group-denied',
          groupId: outsiderGroup.id,
          text: 'Denied outside membership'
        })
      ])

      expect(pendingSend.status).toBe(403)
      expect(crossGroupAgentSend.status).toBe(403)

      const anonymousSend = await createAnonymousClient().rpc('send_agora_message', {
        client_message_id_to_use: 'anonymous-denied',
        group_id_to_use: privateGroup.id,
        message_text_to_use: 'Denied without a principal'
      })

      expect(anonymousSend.error?.code).toBe('42501')

      const removal = await postHuman(owner, agoraRequestIdentifiers.removeMember, {
        groupId: privateGroup.id,
        principalId: member.principalId
      })
      const removedSend = await postHuman(member, agoraRequestIdentifiers.sendMessage, {
        clientMessageId: 'removed-denied',
        groupId: privateGroup.id,
        text: 'Denied after removal'
      })
      const removedRows = await member.client.from('messages').select('id')

      expect(removal.status).toBe(200)
      expect(removedSend.status).toBe(403)
      expect(removedRows.error).toBeNull()
      expect(removedRows.data).toEqual([])

      const messageId = (privateSend.body as AgoraRequestResult<'sendMessage'>).id
      const [forgedInsert, directUpdate, directDelete, idempotencyRead] = await Promise.all([
        owner.client.from('messages').insert({
          group_id: privateGroup.id,
          id: randomUUID(),
          sender_principal_id: outsider.principalId,
          sequence: 99,
          text: 'Forged author'
        }),
        owner.client.from('messages').update({ text: 'Edited' }).eq('id', messageId),
        owner.client.from('messages').delete().eq('id', messageId),
        owner.client.from('message_idempotency_keys').select('message_id')
      ])

      expect(forgedInsert.error).not.toBeNull()
      expect(directUpdate.error).not.toBeNull()
      expect(directDelete.error).not.toBeNull()
      expect(idempotencyRead.error).not.toBeNull()
      expect(await selectCount('messages', 'id', messageId)).toBe(1)
    } finally {
      await Promise.all([removeGroup(privateGroup.id), removeGroup(outsiderGroup.id)])
    }
  })

  it('cascades message and idempotency rows only through owner group deletion', async () => {
    const { owner } = requireFixtures()
    const group = await createGroup(owner, 'Message cascade group')
    let groupDeleted = false

    try {
      for (const index of [1, 2]) {
        const sent = await postHuman(owner, agoraRequestIdentifiers.sendMessage, {
          clientMessageId: `cascade-${index}`,
          groupId: group.id,
          text: `Cascade message ${index}`
        })

        expect(sent.status).toBe(200)
      }

      await expect(Promise.all([
        selectCount('messages', 'group_id', group.id),
        selectCount('message_idempotency_keys', 'group_id', group.id, 'message_id')
      ])).resolves.toEqual([2, 2])

      const deletion = await postHuman(owner, agoraRequestIdentifiers.deleteGroup, {
        groupId: group.id
      })

      expect(deletion).toEqual({ body: { groupId: group.id }, status: 200 })
      groupDeleted = true
      await expect(Promise.all([
        selectCount('messages', 'group_id', group.id),
        selectCount('message_idempotency_keys', 'group_id', group.id, 'message_id')
      ])).resolves.toEqual([0, 0])
    } finally {
      if (!groupDeleted) {
        await removeGroup(group.id)
      }
    }
  })
})
