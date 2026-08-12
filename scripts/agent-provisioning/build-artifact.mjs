#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { runCommand } from '../agent-keys/command.mjs'
import {
  artifactDigest,
  buildManifest,
  manifestName,
  serializeManifest,
  verifyArtifact
} from './artifact-manifest.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const runtimePackageRoot = path.join(repositoryRoot, 'ops/agent-runner')
const defaultOutputRoot = path.join(repositoryRoot, '.agora-runtime/agent-runner-artifacts')
const copyPaths = [
  'ops/agent-runner/handler-output.schema.json',
  'ops/agent-runner/handler-prompt.md',
  'ops/agent-runner/thread-bootstrap-prompt.md',
  'ops/systemd/agora-agent-runner.env.example',
  'ops/systemd/agora-agent-runner@.service',
  'scripts/agent-keys',
  'scripts/agent-provisioning',
  'scripts/agent-runner',
  'scripts/process-identity.mjs',
  'scripts/runtime-state-coordinator.mjs'
]

const parseOutputRoot = (args) => {
  if (args.length === 0) return defaultOutputRoot
  if (args.length === 2 && args[0] === '--output') return path.resolve(args[1])
  throw new Error('Usage: build-artifact.mjs [--output DIRECTORY]')
}

const pathExists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export const buildRunnerArtifact = async ({
  outputRoot = defaultOutputRoot,
  run = runCommand
} = {}) => {
  await mkdir(outputRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(path.join(outputRoot, '.building-'))
  const staging = path.join(temporaryRoot, 'bundle')

  try {
    await mkdir(staging, { mode: 0o755 })
    for (const relativePath of copyPaths) {
      await mkdir(path.dirname(path.join(staging, relativePath)), { recursive: true })
      await cp(path.join(repositoryRoot, relativePath), path.join(staging, relativePath), {
        recursive: true
      })
    }

    await cp(path.join(runtimePackageRoot, 'package.json'), path.join(staging, 'package.json'))
    await cp(path.join(runtimePackageRoot, 'package-lock.json'), path.join(staging, 'package-lock.json'))
    await mkdir(path.join(staging, 'runtime'))
    await cp(process.execPath, path.join(staging, 'runtime/node'))
    await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: staging
    })

    const manifestBytes = Buffer.from(serializeManifest(await buildManifest(staging)))
    await writeFile(path.join(staging, manifestName), manifestBytes, { mode: 0o644 })
    const digest = artifactDigest(manifestBytes)
    const destination = path.join(outputRoot, digest)
    if (await pathExists(destination)) {
      const existing = await verifyArtifact(destination)
      if (existing.digest !== digest) {
        throw new Error('The content-addressed artifact destination is inconsistent.')
      }
      return { destination, digest }
    }
    await rename(staging, destination)
    return { destination, digest }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRunnerArtifact({ outputRoot: parseOutputRoot(process.argv.slice(2)) }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write('{"code":"artifact_build_failed","event":"provisioning_failed","recovery":"npm run build:agent-runner-artifact","stage":"artifact_build"}\n')
      process.exitCode = 1
    }
  )
}
