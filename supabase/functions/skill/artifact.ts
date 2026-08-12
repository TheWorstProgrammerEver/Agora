import {
  skillArtifactBase64,
  skillArtifactEtag,
  skillArtifactFilename,
  skillArtifactVersion
} from './artifact.generated.ts'

const decodeBase64 = (source: string) => Uint8Array.from(atob(source), (character) => (
  character.charCodeAt(0)
))

export const codexSkillArtifact = {
  bytes: decodeBase64(skillArtifactBase64),
  etag: skillArtifactEtag,
  filename: skillArtifactFilename,
  version: skillArtifactVersion
}
