import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  sep
} from 'node:path'

const targets = {
  darwin: {
    arm64: ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    x64: ['@openai/codex-darwin-x64', 'x86_64-apple-darwin']
  },
  linux: {
    arm64: ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    x64: ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl']
  }
}

const isWithin = (root, candidate) => {
  const child = relative(root, candidate)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

const executableAt = (candidate) => {
  const resolved = realpathSync(candidate)
  const details = statSync(resolved)

  if (!details.isFile() || (details.mode & 0o111) === 0) {
    throw new Error('Codex executable is invalid.')
  }

  return resolved
}

const resolveExecutable = (executable, pathSource) => {
  const candidates = isAbsolute(executable)
    ? [executable]
    : pathSource.split(delimiter).filter(Boolean).map((entry) => join(entry, executable))

  for (const candidate of candidates) {
    try {
      return executableAt(candidate)
    } catch {
      // Continue through the bounded PATH candidates.
    }
  }

  throw new Error('Codex executable is unavailable.')
}

const readPackage = (path) => JSON.parse(readFileSync(path, 'utf8'))

const resolvePackagedRuntime = (launcher) => {
  const target = targets[platform()]?.[arch()]
  if (!target) throw new Error('Codex platform is unsupported.')

  const packageRoot = realpathSync(join(dirname(launcher), '..'))
  const packageMetadata = readPackage(join(packageRoot, 'package.json'))
  if (packageMetadata.name !== '@openai/codex'
    || typeof packageMetadata.version !== 'string'
    || realpathSync(join(packageRoot, 'bin/codex.js')) !== launcher) {
    throw new Error('Codex launcher package is invalid.')
  }

  const [platformPackage, targetTriple] = target
  const candidates = []
  try {
    const platformPackagePath = realpathSync(
      createRequire(launcher).resolve(`${platformPackage}/package.json`)
    )
    const platformMetadata = readPackage(platformPackagePath)
    if (platformMetadata.name !== '@openai/codex'
      || !platformMetadata.version?.startsWith(`${packageMetadata.version}-`)
      || !platformMetadata.os?.includes(platform())
      || !platformMetadata.cpu?.includes(arch())) {
      throw new Error('Codex platform package is invalid.')
    }
    candidates.push(join(dirname(platformPackagePath), 'vendor'))
  } catch {
    // The official launcher also supports a vendor tree inside its own package.
  }
  candidates.push(join(packageRoot, 'vendor'))

  for (const candidate of candidates) {
    try {
      const vendorRoot = realpathSync(candidate)
      const executable = executableAt(join(vendorRoot, targetTriple, 'bin', 'codex'))
      if (!isWithin(vendorRoot, executable)) continue
      return executable
    } catch {
      // Continue through the two official package layouts.
    }
  }

  throw new Error('Codex packaged runtime is unavailable.')
}

const readableDirectory = (path) => `${dirname(path)}${sep}`

export const resolveCodexRuntime = (
  executable,
  pathSource = process.env.PATH ?? ''
) => {
  const launcher = resolveExecutable(executable, pathSource)
  const runtime = launcher.endsWith(`${sep}codex.js`)
    ? resolvePackagedRuntime(launcher)
    : launcher

  return {
    executable: launcher,
    readableDirectories: Array.from(new Set([
      readableDirectory(launcher),
      readableDirectory(runtime)
    ]))
  }
}
