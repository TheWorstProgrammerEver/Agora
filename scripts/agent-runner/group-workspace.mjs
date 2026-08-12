import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { HandlerExecutionError } from './handler-error.mjs'
import { isUuid } from './value-validation.mjs'

const inboxDirectoryName = '.agora-inbox'

const assertPrivateDirectory = async (path) => {
  let details
  try {
    details = await lstat(path)
  } catch {
    throw new HandlerExecutionError('handler_failed')
  }

  if (!details.isDirectory()
    || details.isSymbolicLink()
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())
    || (details.mode & 0o077) !== 0) {
    throw new HandlerExecutionError('handler_failed')
  }
}

const ensurePrivateDirectory = async (path) => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  await assertPrivateDirectory(path)
}

const siblingPaths = async (directory, currentName) => (
  (await readdir(directory, { withFileTypes: true }))
    .filter(({ name }) => name !== currentName)
    .map(({ name }) => join(directory, name))
)

export const groupWorkspacePath = (config, context, workspaceId) => {
  if (!isUuid(context.agentPrincipalId)
    || !isUuid(context.groupId)
    || !isUuid(workspaceId)) {
    throw new HandlerExecutionError('handler_failed')
  }

  return join(
    config.workspace,
    inboxDirectoryName,
    context.agentPrincipalId,
    context.groupId,
    workspaceId
  )
}

export const prepareGroupWorkspace = async (config, context, workspaceId) => {
  const inboxRoot = join(config.workspace, inboxDirectoryName)
  const principalRoot = join(inboxRoot, context.agentPrincipalId)
  const groupRoot = join(principalRoot, context.groupId)
  const workspace = groupWorkspacePath(config, context, workspaceId)

  try {
    for (const directory of [inboxRoot, principalRoot, groupRoot, workspace]) {
      await ensurePrivateDirectory(directory)
    }
    const protectedPaths = [
      ...await siblingPaths(inboxRoot, context.agentPrincipalId),
      ...await siblingPaths(principalRoot, context.groupId),
      ...await siblingPaths(groupRoot, workspaceId)
    ]
    return { protectedPaths, workspace }
  } catch (error) {
    if (error instanceof HandlerExecutionError) throw error
    throw new HandlerExecutionError('handler_failed')
  }
}
