import { codexSkillArtifact } from './artifact.ts'
import { createSkillHandler } from './handler.ts'

export default {
  fetch: createSkillHandler(codexSkillArtifact)
}
