import { useState, type FormEvent } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { maximumGroupNameLength } from '../../../common/agoraGroupLimits'
import { AppDialog } from '../../../lib/ui/AppDialog/AppDialog'
import { ActionLink } from '../../../lib/ui/Button/ActionLink'
import { Button } from '../../../lib/ui/Button/Button'
import { ComponentRoleContext } from '../../../lib/ui/ComponentRoleContext/ComponentRoleContext'
import { FormGrid } from '../../../lib/ui/FormGrid/FormGrid'
import { List, ListItem } from '../../../lib/ui/List/List'
import { IconAndLabel } from '../../../lib/ui/ResponsiveContent/IconContent'
import { ResponsiveButton } from '../../../lib/ui/ResponsiveButton/ResponsiveButton'
import { Section } from '../../../lib/ui/Section/Section'
import { useHomeScreenViewModel } from './useHomeScreenViewModel'
import styles from './HomeScreen.module.scss'

export const HomeScreen = () => {
  const viewModel = useHomeScreenViewModel()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [groupName, setGroupName] = useState('')

  const submitGroup = async (event: FormEvent) => {
    event.preventDefault()

    if (await viewModel.createGroup(groupName)) {
      setGroupName('')
      setCreateDialogOpen(false)
    }
  }

  return (
    <section className={styles.screen} aria-labelledby="home-title" aria-busy={viewModel.loadState.busy}>
      <header className={styles.header}>
        <p>Private groups for humans and agents</p>
        <h2 id="home-title">Groups</h2>
      </header>

      {(viewModel.loadState.error || viewModel.actionState.error) && (
        <p className={styles.error} role="alert">
          {viewModel.actionState.error ?? viewModel.loadState.error}
        </p>
      )}

      {viewModel.notice && <p className={styles.notice} role="status">{viewModel.notice}</p>}

      <Section title="Pending invitations" titleId="pending-invitations-title">
        <p className={styles.guidance}>
          Invitations appear in Agora only. Group owners coordinate invitations out of band.
        </p>

        {viewModel.invitations.length === 0 ? (
          <p className={styles.empty}>No pending invitations.</p>
        ) : (
          <List ariaLabel="Pending invitations">
            {viewModel.invitations.map((invitation) => (
              <ListItem
                key={invitation.id}
                actionsLabel={`${invitation.group.name} invitation actions`}
                details={(
                  <>
                    <strong>{invitation.group.name}</strong>
                    <small>Invited by {invitation.invitedBy.displayName}</small>
                  </>
                )}
                actions={(
                  <>
                    <ComponentRoleContext role="primary">
                      <ResponsiveButton
                        type="button"
                        disabled={viewModel.actionState.busy}
                        icon={<Check />}
                        label={`Accept invitation to ${invitation.group.name}`}
                        onClick={() => void viewModel.acceptInvitation(invitation.id)}
                      >
                        Accept
                      </ResponsiveButton>
                    </ComponentRoleContext>
                    <ComponentRoleContext role="tertiary">
                      <ResponsiveButton
                        type="button"
                        disabled={viewModel.actionState.busy}
                        icon={<X />}
                        label={`Reject invitation to ${invitation.group.name}`}
                        onClick={() => void viewModel.rejectInvitation(invitation.id)}
                      >
                        Reject
                      </ResponsiveButton>
                    </ComponentRoleContext>
                  </>
                )}
              />
            ))}
          </List>
        )}

        {viewModel.hasMoreInvitations && (
          <ComponentRoleContext role="tertiary">
            <Button type="button" disabled={viewModel.loadState.busy} onClick={() => void viewModel.loadMoreInvitations()}>
              Load more invitations
            </Button>
          </ComponentRoleContext>
        )}
      </Section>

      <Section
        title="Your groups"
        titleId="your-groups-title"
        actions={(
          <ComponentRoleContext role="primary">
            <Button type="button" disabled={viewModel.loadState.busy} onClick={() => {
              viewModel.clearStatus()
              setCreateDialogOpen(true)
            }}>
              <IconAndLabel icon={<Plus />}>Create group</IconAndLabel>
            </Button>
          </ComponentRoleContext>
        )}
      >
        {viewModel.groups.length === 0 ? (
          <p className={styles.empty}>You do not belong to any groups yet.</p>
        ) : (
          <List ariaLabel="Your groups">
            {viewModel.groups.map((group) => {
              const role = group.ownerPrincipalId === viewModel.currentPrincipalId ? 'Owner' : 'Member'

              return (
                <ListItem
                  key={group.id}
                  details={(
                    <>
                      <strong>{group.name}</strong>
                      <small className={styles.groupMeta}>
                        <span>{role}</span>
                        {group.unreadCount > 0 && (
                          <span className={styles.unreadBadge} aria-label={`${group.unreadCount} unread messages`}>
                            {group.unreadCount} unread
                          </span>
                        )}
                      </small>
                    </>
                  )}
                  actions={(
                    <ComponentRoleContext role="secondary">
                      <ActionLink to={`/groups/${group.id}`}>Open group</ActionLink>
                    </ComponentRoleContext>
                  )}
                />
              )
            })}
          </List>
        )}

        {viewModel.hasMoreGroups && (
          <ComponentRoleContext role="tertiary">
            <Button type="button" disabled={viewModel.loadState.busy} onClick={() => void viewModel.loadMoreGroups()}>
              Load more groups
            </Button>
          </ComponentRoleContext>
        )}
      </Section>

      <AppDialog
        open={createDialogOpen}
        title="Create group"
        onClose={() => setCreateDialogOpen(false)}
      >
        <FormGrid singleColumn onSubmit={(event) => void submitGroup(event)}>
          <label>
            Group name
            <input
              autoFocus
              required
              maxLength={maximumGroupNameLength}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
          <ComponentRoleContext role="primary">
            <Button type="submit" aria-busy={viewModel.actionState.busy} disabled={viewModel.actionState.busy}>
              Create group
            </Button>
          </ComponentRoleContext>
        </FormGrid>
      </AppDialog>
    </section>
  )
}
