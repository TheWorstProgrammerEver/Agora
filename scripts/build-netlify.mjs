import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'

const distConfigLoaderPath = 'dist/config.js'
const distConfigTemplatePath = 'dist/config.json'
const netlifyConfigFile = '/config.json'

const build = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  env: process.env
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const jsStringValue = (value) => value
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/\r/g, '\\r')
  .replace(/\n/g, '\\n')

const requireEnvironmentValue = (token, missingTokens) => {
  const value = process.env[token]

  if (value === undefined) {
    missingTokens.add(token)

    return ''
  }

  return value
}

const jsonValue = (token, missingTokens, isQuoted) => {
  const value = requireEnvironmentValue(token, missingTokens)

  if (missingTokens.has(token)) {
    return ''
  }

  return isQuoted ? JSON.stringify(value) : value
}

const renderConfigLoader = async () => {
  const template = await fs.readFile(distConfigLoaderPath, 'utf8')
  const configLoader = template.replaceAll('#{CONFIG_FILE}#', jsStringValue(netlifyConfigFile))

  if (/#\{[A-Z0-9_]+\}#/.test(configLoader)) {
    throw new Error(`${distConfigLoaderPath} contains unresolved config tokens.`)
  }

  await fs.writeFile(distConfigLoaderPath, configLoader)
  console.log(`Rendered ${distConfigLoaderPath}`)
}

const renderConfigJson = async () => {
  const template = await fs.readFile(distConfigTemplatePath, 'utf8')
  const missingTokens = new Set()
  const rendered = template.replace(/"#\{([A-Z0-9_]+)\}#"|#\{([A-Z0-9_]+)\}#/g, (_, quotedToken, rawToken) => (
    jsonValue(quotedToken ?? rawToken, missingTokens, Boolean(quotedToken))
  ))

  if (missingTokens.size) {
    throw new Error(`Missing Netlify environment variables: ${[...missingTokens].join(', ')}`)
  }

  const config = JSON.parse(rendered)

  await fs.writeFile(distConfigTemplatePath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Rendered ${distConfigTemplatePath}`)
}

await renderConfigLoader()
await renderConfigJson()
