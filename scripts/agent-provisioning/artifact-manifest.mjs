import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export const manifestName = 'agora-runner-manifest.json'

const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

const walk = async (root, directory = root) => {
  const entries = []

  for (const name of (await readdir(directory)).sort()) {
    const target = path.join(directory, name)
    const relativePath = path.relative(root, target).split(path.sep).join('/')
    const metadata = await lstat(target)

    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error('Runner artifact contains an unsupported filesystem entry.')
    }

    if (metadata.isDirectory()) {
      entries.push(...await walk(root, target))
      continue
    }

    if (relativePath !== manifestName) {
      entries.push({
        mode: metadata.mode & 0o777,
        path: relativePath,
        sha256: hashBytes(await readFile(target)),
        size: metadata.size
      })
    }
  }

  return entries
}

export const buildManifest = async (root) => ({
  files: await walk(root),
  format: 'agora-runner-artifact-v1'
})

export const serializeManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`

export const artifactDigest = (manifestBytes) => hashBytes(manifestBytes)

export const verifyArtifact = async (root) => {
  const manifestBytes = await readFile(path.join(root, manifestName))
  let expected

  try {
    expected = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('Runner artifact manifest is malformed.')
  }

  const actual = await buildManifest(root)
  if (serializeManifest(actual) !== serializeManifest(expected)) {
    throw new Error('Runner artifact does not match its manifest.')
  }

  return { digest: artifactDigest(manifestBytes), manifest: actual }
}
