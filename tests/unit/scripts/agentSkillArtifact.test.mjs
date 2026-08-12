import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agoraContractVersion, agoraRequestNames } from '../../../common/agoraRequestIdentifiers.ts'
import { isAgoraRequestParams } from '../../../common/agoraRequestValidation.ts'
import {
  assertSafeSkillSources,
  buildAgentSkill
} from '../../../scripts/generate-agent-skill.mjs'
import { readStoredZip } from '../../../scripts/agent-skill/zip.mjs'
import { skillArtifactEtag } from '../../../supabase/functions/skill/artifact.generated.ts'

const expectedLayout = [
  'agora/SKILL.md',
  'agora/references/api-v1.md',
  'agora/references/examples.md',
  'agora/references/operator-guide.md'
]

const generatedModulePath = resolve('supabase/functions/skill/artifact.generated.ts')
const generatedReferencePath = resolve('agent-skill/agora/references/api-v1.md')

describe('downloadable Agora Codex skill', () => {
  it('is deterministic and matches the committed generated artifacts', async () => {
    const [first, second, committedModule, committedReference] = await Promise.all([
      buildAgentSkill(),
      buildAgentSkill(),
      readFile(generatedModulePath, 'utf8'),
      readFile(generatedReferencePath, 'utf8')
    ])

    expect(first.archive).toEqual(second.archive)
    expect(first.apiReference).toBe(second.apiReference)
    expect(first.generatedModule).toBe(committedModule)
    expect(first.apiReference).toBe(committedReference)
    expect(first.version).toBe(String(agoraContractVersion))
    expect(skillArtifactEtag).toBe(
      `"sha256-${createHash('sha256').update(first.archive).digest('hex')}"`
    )
  })

  it('has the exact safe archive layout and generated dispatcher catalog', async () => {
    const built = await buildAgentSkill()
    const entries = readStoredZip(built.archive)

    expect([...entries.keys()]).toEqual(expectedLayout)
    const reference = entries.get('agora/references/api-v1.md').toString('utf8')
    const documentedIdentifiers = [...reference.matchAll(/^- `([A-Za-z][A-Za-z0-9]+)`$/gm)]
      .map((match) => match[1])
    expect(documentedIdentifiers).toEqual(agoraRequestNames)
    expect(reference).toContain(`Contract version: \`${agoraContractVersion}\``)
  })

  it('never captures ambient secrets, credentials, or deployment data', async () => {
    const sentinel = `agora_agent_v1_${'Z'.repeat(43)}`
    const original = process.env.AGORA_AGENT_KEY
    process.env.AGORA_AGENT_KEY = sentinel
    const built = await buildAgentSkill().finally(() => {
      if (original === undefined) delete process.env.AGORA_AGENT_KEY
      else process.env.AGORA_AGENT_KEY = original
    })
    const entries = readStoredZip(built.archive)
    const content = [...entries.values()].map((entry) => entry.toString('utf8')).join('\n')

    expect(Buffer.from(built.archive).includes(Buffer.from(sentinel))).toBe(false)
    expect(content).not.toMatch(/agora_agent_v1_[A-Za-z0-9_-]{43}/)
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/)
    expect(content).not.toMatch(/\/home\/[^/\s]+/)
    expect(content).not.toMatch(/(?:192\.168|10\.\d{1,3})\.\d{1,3}\.\d{1,3}/)
    expect(() => assertSafeSkillSources([{
      name: 'agora/SKILL.md',
      source: `Accidentally embedded: ${sentinel}`
    }])).toThrow('Agora skill source contains forbidden agent application key content.')
  })

  it('keeps every documented request example executable through the contract validator', async () => {
    const source = await readFile('agent-skill/agora/references/examples.md', 'utf8')
    const examples = [...source.matchAll(/<!-- agora-request:([A-Za-z][A-Za-z0-9]+) -->\n```json\n([\s\S]*?)```/g)]

    expect(examples.length).toBeGreaterThan(0)
    for (const [, expectedIdentifier, json] of examples) {
      const envelope = JSON.parse(json)
      expect(envelope).toEqual({
        identifier: expectedIdentifier,
        params: envelope.params,
        version: agoraContractVersion
      })
      expect(agoraRequestNames).toContain(expectedIdentifier)
      expect(isAgoraRequestParams(expectedIdentifier, envelope.params)).toBe(true)
    }
  })

  it('teaches context-before-action and acknowledgement-after-processing', async () => {
    const built = await buildAgentSkill()
    const entries = readStoredZip(built.archive)
    const skill = entries.get('agora/SKILL.md').toString('utf8')

    expect(skill).toContain('Load more context with `getGroupMessages` before acting whenever a message is')
    expect(skill).toContain('Call `markGroupRead` only after the handler succeeds')
    expect(skill.indexOf('Load more context')).toBeLessThan(skill.indexOf('Call `markGroupRead`'))
  })
})
