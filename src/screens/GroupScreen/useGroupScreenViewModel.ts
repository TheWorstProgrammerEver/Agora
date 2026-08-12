import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { defaultMemberListPageSize } from '../../../common/agoraGroupLimits'
import type { GroupDto, GroupMemberDto } from '../../../common/agoraDtos'
import { useLoader } from '../../../lib/hooks/useLoader'
import {
  addAgentMember,
  deleteGroup,
  getGroup,
  inviteHuman,
  listGroupMembers,
  removeMember
} from '../../data/agora/agoraClient'
import {
  appendMemberPage,
  removeMemberByPrincipalId,
  upsertMember
} from '../../state/groupStateUpdates'

export const useGroupScreenViewModel = () => {
  const navigate = useNavigate()
  const { groupId = '' } = useParams()
  const [group, setGroup] = useState<GroupDto>()
  const [currentMember, setCurrentMember] = useState<GroupMemberDto>()
  const [members, setMembers] = useState<GroupMemberDto[]>([])
  const [memberCursor, setMemberCursor] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const loadState = useLoader()
  const actionState = useLoader()

  const loadGroup = useCallback(async () => {
    if (!groupId) {
      return
    }

    try {
      const [groupResult, memberPage] = await loadState.execute(() => Promise.all([
        getGroup({ groupId }),
        listGroupMembers({ groupId, limit: defaultMemberListPageSize })
      ]))
      setGroup(groupResult.group)
      setCurrentMember(groupResult.currentMember)
      setMembers(memberPage.items)
      setMemberCursor(memberPage.nextCursor)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [groupId, loadState.execute])

  useEffect(() => {
    void loadGroup()
  }, [loadGroup])

  const loadMoreMembers = useCallback(async () => {
    if (!memberCursor) {
      return
    }

    try {
      const page = await loadState.execute(() => listGroupMembers({
        cursor: memberCursor,
        groupId,
        limit: defaultMemberListPageSize
      }))
      setMembers((current) => appendMemberPage(current, page.items))
      setMemberCursor(page.nextCursor)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [groupId, loadState.execute, memberCursor])

  const inviteHumanMember = useCallback(async (email: string) => {
    setNotice(undefined)

    try {
      const { invitation } = await actionState.execute(() => inviteHuman({
        email: email.trim(),
        groupId
      }))
      setNotice(`Invitation ready for ${invitation.email}. Coordinate with them out of band.`)
      return true
    } catch {
      return false
    }
  }, [actionState.execute, groupId])

  const addAgent = useCallback(async (agentPrincipalId: string) => {
    setNotice(undefined)

    try {
      const { member } = await actionState.execute(() => addAgentMember({
        agentPrincipalId: agentPrincipalId.trim(),
        groupId
      }))
      setMembers((current) => upsertMember(current, member))
      setNotice(`${member.principal.displayName} added.`)
      return true
    } catch {
      return false
    }
  }, [actionState.execute, groupId])

  const removeGroupMember = useCallback(async (principalId: string) => {
    setNotice(undefined)

    try {
      const removed = await actionState.execute(() => removeMember({ groupId, principalId }))
      setMembers((current) => removeMemberByPrincipalId(current, removed.principalId))
      setNotice('Member removed.')
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [actionState.execute, groupId])

  const deleteCurrentGroup = useCallback(async () => {
    setNotice(undefined)

    try {
      await actionState.execute(() => deleteGroup({ groupId }))
      navigate('/', { replace: true })
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [actionState.execute, groupId, navigate])

  const clearStatus = useCallback(() => {
    actionState.clearError()
    loadState.clearError()
    setNotice(undefined)
  }, [actionState.clearError, loadState.clearError])

  return {
    actionState,
    addAgent,
    canManage: currentMember?.role === 'owner',
    clearStatus,
    currentMember,
    deleteGroup: deleteCurrentGroup,
    group,
    hasMoreMembers: Boolean(memberCursor),
    inviteHuman: inviteHumanMember,
    loadMoreMembers,
    loadState,
    members,
    notice,
    removeMember: removeGroupMember
  }
}
