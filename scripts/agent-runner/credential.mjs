import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { agentKeyPattern, credentialName } from './constants.mjs'

const isOwnedDirectory = (stat, currentUid) => (
  stat.uid === currentUid
  && (stat.mode & 0o077) === 0
  && (stat.mode & 0o700) === 0o700
)

const isSystemdDirectory = (stat) => (
  stat.uid === 0
  && (stat.mode & 0o777) === 0o550
)

const isOwnedCredential = (stat, currentUid) => (
  stat.uid === currentUid
  && (stat.mode & 0o177) === 0
  && (stat.mode & 0o400) === 0o400
)

const isSystemdCredential = (stat) => (
  stat.uid === 0
  && (stat.mode & 0o777) === 0o440
)

const hasValidDirectoryCustody = (stat) => (
  isOwnedDirectory(stat, process.getuid?.())
  || isSystemdDirectory(stat)
)

const hasValidCredentialCustody = (stat) => (
  isOwnedCredential(stat, process.getuid?.())
  || isSystemdCredential(stat)
)

export const readAgentCredential = async (credentialDirectory) => {
  let directoryStat
  let credentialStat

  try {
    directoryStat = await lstat(credentialDirectory)
    credentialStat = await lstat(join(credentialDirectory, credentialName))
  } catch {
    throw new Error('Agora runner credential is unavailable.')
  }

  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || !hasValidDirectoryCustody(directoryStat)
    || !credentialStat.isFile()
    || credentialStat.isSymbolicLink()
    || credentialStat.nlink !== 1
    || credentialStat.size < 1
    || credentialStat.size > 128
    || !hasValidCredentialCustody(credentialStat)) {
    throw new Error('Agora runner credential custody is invalid.')
  }

  const path = join(credentialDirectory, credentialName)
  let handle

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedStat = await handle.stat()

    if (!openedStat.isFile()
      || openedStat.dev !== credentialStat.dev
      || openedStat.ino !== credentialStat.ino
      || openedStat.nlink !== 1
      || openedStat.size !== credentialStat.size
      || !hasValidCredentialCustody(openedStat)) {
      throw new Error('Agora runner credential custody is invalid.')
    }

    const key = await handle.readFile({ encoding: 'utf8' })

    if (!agentKeyPattern.test(key)) {
      throw new Error('Agora runner credential is invalid.')
    }

    return key
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Agora runner credential')) {
      throw error
    }

    throw new Error('Agora runner credential could not be read.')
  } finally {
    await handle?.close()
  }
}
