import { useState, type FormEvent } from 'react'
import { Bot, MailPlus, Trash2, UserMinus } from 'lucide-react'
import { AppDialog, DialogFooterActions } from '../../../lib/ui/AppDialog/AppDialog'
import { Button } from '../../../lib/ui/Button/Button'
import { ComponentRoleContext } from '../../../lib/ui/ComponentRoleContext/ComponentRoleContext'
import { FormGrid } from '../../../lib/ui/FormGrid/FormGrid'
import { List, ListItem } from '../../../lib/ui/List/List'
import { IconAndLabel } from '../../../lib/ui/ResponsiveContent/IconContent'
import { ResponsiveButton } from '../../../lib/ui/ResponsiveButton/ResponsiveButton'
import { Section } from '../../../lib/ui/Section/Section'
import { ConversationPanel } from './ConversationPanel'
import { useGroupScreenViewModel } from './useGroupScreenViewModel'
import styles from './GroupScreen.module.scss'

const principalDescription = (kind: 'agent' | 'human', role: 'member' | 'owner') => (
  `${kind === 'agent' ? 'Agent' : 'Human'} · ${role === 'owner' ? 'Owner' : 'Member'}`
)

export const GroupScreen = () => {
  const viewModel = useGroupScreenViewModel()
  const [inviteEmail, setInviteEmail] = useState('')
  const [agentPrincipalId, setAgentPrincipalId] = useState('')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const submitInvitation = async (event: FormEvent) => {
    event.preventDefault()

    if (await viewModel.inviteHuman(inviteEmail)) {
      setInviteEmail('')
    }
  }

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault()

    if (await viewModel.addAgent(agentPrincipalId)) {
      setAgentPrincipalId('')
    }
  }

  if (!viewModel.group && viewModel.loadState.busy) {
    return <section className={styles.screen} aria-busy="true" aria-label="Loading group" />
  }

  if (!viewModel.group || viewModel.conversation.accessRevoked) {
    return (
      <section className={styles.screen} aria-labelledby="group-unavailable-title">
        <h2 id="group-unavailable-title">Group unavailable</h2>
        <p role="alert">
          {viewModel.conversation.accessRevoked
            ? 'You no longer have access to this group.'
            : viewModel.loadState.error ?? 'This group could not be loaded.'}
        </p>
      </section>
    )
  }

  return (
    <section className={styles.screen} aria-labelledby="group-title">
      <header className={styles.header}>
        <span className={styles.role}>{viewModel.canManage ? 'Owner' : 'Member'}</span>
        <h2 id="group-title">{viewModel.group.name}</h2>
        {viewModel.canManage && (
          <ComponentRoleContext role="destructive">
            <Button type="button" onClick={() => setDeleteDialogOpen(true)}>
              <IconAndLabel icon={<Trash2 />}>Delete group</IconAndLabel>
            </Button>
          </ComponentRoleContext>
        )}
      </header>

      {(viewModel.loadState.error || viewModel.actionState.error) && (
        <p className={styles.error} role="alert">
          {viewModel.actionState.error ?? viewModel.loadState.error}
        </p>
      )}
      {viewModel.notice && <p className={styles.notice} role="status">{viewModel.notice}</p>}

      <ConversationPanel conversation={viewModel.conversation} groupName={viewModel.group.name} />

      <Section title="Participants" titleId="group-members-title">
        <List ariaLabel={`${viewModel.group.name} members`}>
          {viewModel.members.map((member) => (
            <ListItem
              key={member.principal.id}
              actionsLabel={`${member.principal.displayName} member actions`}
              leading={member.principal.kind === 'agent' ? <Bot aria-hidden="true" /> : undefined}
              details={(
                <>
                  <strong>{member.principal.displayName}</strong>
                  <small>{principalDescription(member.principal.kind, member.role)}</small>
                </>
              )}
              actions={viewModel.canManage && member.role !== 'owner' ? (
                <ComponentRoleContext role="destructive">
                  <ResponsiveButton
                    type="button"
                    disabled={viewModel.actionState.busy}
                    icon={<UserMinus />}
                    label={`Remove ${member.principal.displayName}`}
                    onClick={() => void viewModel.removeMember(member.principal.id)}
                  >
                    Remove
                  </ResponsiveButton>
                </ComponentRoleContext>
              ) : undefined}
            />
          ))}
        </List>

        {viewModel.hasMoreMembers && (
          <ComponentRoleContext role="tertiary">
            <Button type="button" disabled={viewModel.loadState.busy} onClick={() => void viewModel.loadMoreMembers()}>
              Load more members
            </Button>
          </ComponentRoleContext>
        )}
      </Section>

      {viewModel.canManage && (
        <section className={styles.management} aria-label="Group management">
          <Section title="Invite a person" titleId="invite-person-title">
            <p className={styles.guidance}>
              This creates an in-app invitation only. Coordinate with the person out of band.
            </p>
            <FormGrid singleColumn onSubmit={(event) => void submitInvitation(event)}>
              <label>
                Email
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </label>
              <ComponentRoleContext role="primary">
                <Button type="submit" disabled={viewModel.actionState.busy}>
                  <IconAndLabel icon={<MailPlus />}>Create invitation</IconAndLabel>
                </Button>
              </ComponentRoleContext>
            </FormGrid>
          </Section>

          <Section title="Add an agent" titleId="add-agent-title">
            <p className={styles.guidance}>
              Enter the principal ID of an agent that has already been provisioned.
            </p>
            <FormGrid singleColumn onSubmit={(event) => void submitAgent(event)}>
              <label>
                Agent principal ID
                <input
                  required
                  inputMode="text"
                  pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
                  value={agentPrincipalId}
                  onChange={(event) => setAgentPrincipalId(event.target.value)}
                />
              </label>
              <ComponentRoleContext role="primary">
                <Button type="submit" disabled={viewModel.actionState.busy}>
                  <IconAndLabel icon={<Bot />}>Add agent</IconAndLabel>
                </Button>
              </ComponentRoleContext>
            </FormGrid>
          </Section>
        </section>
      )}

      <AppDialog
        open={deleteDialogOpen}
        title={`Delete ${viewModel.group.name}?`}
        onClose={() => setDeleteDialogOpen(false)}
        footer={(
          <DialogFooterActions>
            <ComponentRoleContext role="destructive">
              <Button
                type="button"
                aria-busy={viewModel.actionState.busy}
                disabled={viewModel.actionState.busy}
                onClick={() => void viewModel.deleteGroup()}
              >
                Delete group
              </Button>
            </ComponentRoleContext>
            <ComponentRoleContext role="tertiary">
              <Button type="button" disabled={viewModel.actionState.busy} onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </Button>
            </ComponentRoleContext>
          </DialogFooterActions>
        )}
      >
        <p className={styles.deleteWarning}>
          This permanently deletes the group and its membership state. This cannot be undone.
        </p>
      </AppDialog>
    </section>
  )
}
