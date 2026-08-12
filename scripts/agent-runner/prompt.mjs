import { readFile } from 'node:fs/promises'

export const buildHandlerPrompt = async ({
  apiCli,
  context,
  promptPath
}) => {
  const instructions = await readFile(promptPath, 'utf8')
  const payload = {
    agentPrincipalId: context.agentPrincipalId,
    apiCli,
    chunkId: context.chunkId,
    cursor: context.cursor,
    groupId: context.groupId,
    messages: context.messages,
    sequenceRange: {
      fromExclusive: context.cursor,
      throughInclusive: context.through
    }
  }

  return `${instructions.trim()}\n\n## Chunk context\n\n${JSON.stringify(payload, null, 2)}\n`
}
