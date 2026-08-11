import { KeyRound, LogOut, Pencil, Trash2 } from 'lucide-react'
import { ActionGroup } from '../../../lib/ui/ActionGroup/ActionGroup'
import { Button } from '../../../lib/ui/Button/Button'
import { ComponentRoleContext } from '../../../lib/ui/ComponentRoleContext/ComponentRoleContext'
import { HeaderWithActions } from '../../../lib/ui/HeaderWithActions/HeaderWithActions'
import { IconAndLabel } from '../../../lib/ui/ResponsiveContent/IconContent'
import { ResponsiveButton } from '../../../lib/ui/ResponsiveButton/ResponsiveButton'
import { useProfileScreenViewModel } from './useProfileScreenViewModel'
import styles from './ProfileScreen.module.scss'

const displayDate = (isoDate?: string) => (
  isoDate ? new Date(isoDate).toLocaleDateString() : 'Never'
)

export const ProfileScreen = () => {
  const viewModel = useProfileScreenViewModel()

  return (
    <section className={styles.screen} aria-labelledby="profile-title">
      <header>
        <h2 id="profile-title">Profile</h2>
      </header>

      <dl>
        <div>
          <dt>Name</dt>
          <dd>{viewModel.currentAccount?.name}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{viewModel.currentAccount?.email}</dd>
        </div>
      </dl>

      <section className={styles.passkeys} aria-labelledby="passkeys-title">
        <HeaderWithActions
          header={<h3 id="passkeys-title">Passkeys</h3>}
          actions={(
            <Button
              type="button"
              aria-busy={viewModel.passkeyBusy}
              disabled={viewModel.passkeyBusy}
              onClick={() => void viewModel.registerPasskey()}
            >
              <IconAndLabel icon={<KeyRound />}>Add passkey</IconAndLabel>
            </Button>
          )}
        />

        {viewModel.passkeyError && (
          <p className={styles.error} role="alert">
            {viewModel.passkeyError}
          </p>
        )}

        {viewModel.passkeyNotice && (
          <p className={styles.notice} role="status">
            {viewModel.passkeyNotice}
          </p>
        )}

        {viewModel.passkeys.length === 0 ? (
          <p>No passkeys registered.</p>
        ) : (
          <ul>
            {viewModel.passkeys.map((passkey) => (
              <li key={passkey.id}>
                <span className={styles.passkeyDetails}>
                  <strong>{passkey.friendlyName ?? 'Passkey'}</strong>
                  <small>
                    Created {displayDate(passkey.createdAt)} - Last used {displayDate(passkey.lastUsedAt)}
                  </small>
                </span>
                <ActionGroup
                  className={styles.passkeyActions}
                  ariaLabel={`${passkey.friendlyName ?? 'Passkey'} actions`}
                >
                  <ComponentRoleContext role="tertiary">
                    <ResponsiveButton
                      type="button"
                      disabled={viewModel.passkeyBusy}
                      icon={<Pencil />}
                      label="Rename"
                      onClick={() => void viewModel.renamePasskey(passkey)}
                    />
                  </ComponentRoleContext>
                  <ComponentRoleContext role="destructive">
                    <ResponsiveButton
                      type="button"
                      disabled={viewModel.passkeyBusy}
                      icon={<Trash2 />}
                      label="Delete"
                      onClick={() => viewModel.deletePasskey(passkey.id)}
                    />
                  </ComponentRoleContext>
                </ActionGroup>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ComponentRoleContext role="tertiary">
        <Button className={styles.logout} type="button" onClick={() => void viewModel.signOut()}>
          <LogOut aria-hidden="true" />
          Log out
        </Button>
      </ComponentRoleContext>
    </section>
  )
}
