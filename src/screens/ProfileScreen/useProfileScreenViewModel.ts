import { useCallback, useEffect, useState } from 'react'
import { useConfirmation } from '../../../lib/hooks/useConfirmation'
import { useLoader } from '../../../lib/hooks/useLoader'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  deletePasskey,
  listPasskeys,
  registerPasskey,
  renamePasskey,
  type AccountPasskey
} from '../../data/supabaseAuthRepository'

export const useProfileScreenViewModel = () => {
  const { currentAccount, signOut } = useAuthContext()
  const [passkeys, setPasskeys] = useState<AccountPasskey[]>([])
  const [passkeyNotice, setPasskeyNotice] = useState<string>()
  const passkeyLoader = useLoader()
  const confirmDeletePasskey = useConfirmation('Delete this passkey?')
  const {
    clearError: clearPasskeyError,
    execute: executePasskeyAction
  } = passkeyLoader

  const loadPasskeys = useCallback(async () => {
    if (!currentAccount) {
      setPasskeys([])
      return
    }

    try {
      const nextPasskeys = await executePasskeyAction(listPasskeys)
      setPasskeys(nextPasskeys)
    } catch {
      setPasskeys([])
    }
  }, [currentAccount, executePasskeyAction])

  useEffect(() => {
    void loadPasskeys()
  }, [loadPasskeys])

  const registerNewPasskey = useCallback(async () => {
    setPasskeyNotice(undefined)

    try {
      const passkey = await executePasskeyAction(registerPasskey)
      setPasskeys((current) => [
        passkey,
        ...current.filter((candidate) => candidate.id !== passkey.id)
      ])
      setPasskeyNotice('Passkey registered.')
    } catch {
      // The loader has captured the error for the UI.
    }
  }, [executePasskeyAction])

  const renameExistingPasskey = useCallback(async (passkey: AccountPasskey) => {
    const friendlyName = window.prompt('Passkey name', passkey.friendlyName ?? '')

    if (friendlyName === null) {
      return
    }

    const trimmedName = friendlyName.trim()

    if (!trimmedName) {
      return
    }

    setPasskeyNotice(undefined)

    try {
      const updatedPasskey = await executePasskeyAction(() => renamePasskey(passkey.id, trimmedName))
      setPasskeys((current) => current.map((candidate) => (
        candidate.id === updatedPasskey.id ? updatedPasskey : candidate
      )))
      setPasskeyNotice('Passkey renamed.')
    } catch {
      // The loader has captured the error for the UI.
    }
  }, [executePasskeyAction])

  const deleteExistingPasskey = useCallback((passkeyId: string) => {
    confirmDeletePasskey(() => {
      setPasskeyNotice(undefined)
      void executePasskeyAction(() => deletePasskey(passkeyId))
        .then(() => {
          setPasskeys((current) => current.filter((passkey) => passkey.id !== passkeyId))
          setPasskeyNotice('Passkey deleted.')
        })
        .catch(() => {
          // The loader has captured the error for the UI.
        })
    })
  }, [confirmDeletePasskey, executePasskeyAction])

  const clearPasskeyStatus = useCallback(() => {
    clearPasskeyError()
    setPasskeyNotice(undefined)
  }, [clearPasskeyError])

  return {
    clearPasskeyStatus,
    currentAccount,
    deletePasskey: deleteExistingPasskey,
    passkeyError: passkeyLoader.error,
    passkeyNotice,
    passkeyBusy: passkeyLoader.busy,
    passkeys,
    registerPasskey: registerNewPasskey,
    renamePasskey: renameExistingPasskey,
    signOut
  }
}
