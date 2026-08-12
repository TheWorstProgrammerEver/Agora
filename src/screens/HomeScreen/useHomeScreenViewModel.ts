import { useCallback, useEffect, useState } from 'react'
import {
  defaultGroupListPageSize,
  defaultInvitationListPageSize
} from '../../../common/agoraGroupLimits'
import type { GroupSummaryDto, InvitationDto } from '../../../common/agoraDtos'
import { useLoader } from '../../../lib/hooks/useLoader'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  acceptInvitation,
  createGroup,
  getGroup,
  listGroups,
  listPendingInvitations,
  rejectInvitation
} from '../../data/agora/agoraClient'
import {
  appendPageById,
  prependById,
  removeById,
  summarizeGroup
} from '../../state/groupStateUpdates'

export const useHomeScreenViewModel = () => {
  const { currentAccount } = useAuthContext()
  const [groups, setGroups] = useState<GroupSummaryDto[]>([])
  const [groupCursor, setGroupCursor] = useState<string>()
  const [invitations, setInvitations] = useState<InvitationDto[]>([])
  const [invitationCursor, setInvitationCursor] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const loadState = useLoader()
  const actionState = useLoader()

  const loadInitialState = useCallback(async () => {
    try {
      const [groupPage, invitationPage] = await loadState.execute(() => Promise.all([
        listGroups({ limit: defaultGroupListPageSize }),
        listPendingInvitations({ limit: defaultInvitationListPageSize })
      ]))
      setGroups(groupPage.items)
      setGroupCursor(groupPage.nextCursor)
      setInvitations(invitationPage.items)
      setInvitationCursor(invitationPage.nextCursor)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [loadState.execute])

  useEffect(() => {
    void loadInitialState()
  }, [loadInitialState])

  const loadMoreGroups = useCallback(async () => {
    if (!groupCursor) {
      return
    }

    try {
      const page = await loadState.execute(() => listGroups({
        cursor: groupCursor,
        limit: defaultGroupListPageSize
      }))
      setGroups((current) => appendPageById(current, page.items))
      setGroupCursor(page.nextCursor)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [groupCursor, loadState.execute])

  const loadMoreInvitations = useCallback(async () => {
    if (!invitationCursor) {
      return
    }

    try {
      const page = await loadState.execute(() => listPendingInvitations({
        cursor: invitationCursor,
        limit: defaultInvitationListPageSize
      }))
      setInvitations((current) => appendPageById(current, page.items))
      setInvitationCursor(page.nextCursor)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [invitationCursor, loadState.execute])

  const createNewGroup = useCallback(async (name: string) => {
    setNotice(undefined)

    try {
      const { group } = await actionState.execute(() => createGroup({ name: name.trim() }))
      setGroups((current) => prependById(current, summarizeGroup(group)))
      setNotice(`${group.name} created.`)
      return true
    } catch {
      return false
    }
  }, [actionState.execute])

  const acceptPendingInvitation = useCallback(async (invitationId: string) => {
    setNotice(undefined)

    try {
      const accepted = await actionState.execute(() => acceptInvitation({ invitationId }))
      setInvitations((current) => removeById(current, accepted.invitationId))
      const { group } = await actionState.execute(() => getGroup({ groupId: accepted.groupId }))
      setGroups((current) => prependById(current, summarizeGroup(group)))
      setNotice(`Joined ${group.name}.`)
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [actionState.execute])

  const rejectPendingInvitation = useCallback(async (invitationId: string) => {
    setNotice(undefined)

    try {
      const rejected = await actionState.execute(() => rejectInvitation({ invitationId }))
      setInvitations((current) => removeById(current, rejected.invitationId))
      setNotice('Invitation rejected.')
    } catch {
      // The loader exposes the error to the screen.
    }
  }, [actionState.execute])

  const clearStatus = useCallback(() => {
    actionState.clearError()
    loadState.clearError()
    setNotice(undefined)
  }, [actionState.clearError, loadState.clearError])

  return {
    acceptInvitation: acceptPendingInvitation,
    actionState,
    clearStatus,
    createGroup: createNewGroup,
    currentPrincipalId: currentAccount?.id,
    groups,
    hasMoreGroups: Boolean(groupCursor),
    hasMoreInvitations: Boolean(invitationCursor),
    invitations,
    loadMoreGroups,
    loadMoreInvitations,
    loadState,
    notice,
    rejectInvitation: rejectPendingInvitation
  }
}
