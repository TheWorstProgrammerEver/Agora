import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const appPort = 5173
const supabasePort = 54321
const studioPort = 54323
const mailPort = 54324
const supabaseConfigPath = 'supabase/config.toml'

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false
  })
  let stdout = ''
  let stderr = ''

  if (options.capture) {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
  }

  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0) {
      resolve({ stdout, stderr })
      return
    }

    const error = new Error(`${command} ${args.join(' ')} exited ${code}`)
    error.stdout = stdout
    error.stderr = stderr
    reject(error)
  })
})

const tryRun = async (command, args, options = {}) => {
  try {
    return {
      ok: true,
      ...await run(command, args, options)
    }
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      message: error.message
    }
  }
}

const httpOk = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const pidsListeningOnPort = async (port) => {
  const result = await tryRun('lsof', ['-ti', `tcp:${port}`], { capture: true })

  if (!result.ok) {
    return []
  }

  return [...new Set(result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean))]
}

const killPids = async (label, pids) => {
  if (pids.length === 0) {
    console.log(`OK  ${label} already stopped`)
    return
  }

  console.log(`Stopping ${label} (${pids.join(', ')})...`)
  await tryRun('kill', pids)
}

const getSupabaseProjectId = () => {
  const config = readFileSync(supabaseConfigPath, 'utf8')
  const match = config.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)

  if (!match) {
    throw new Error('Could not find project_id in supabase/config.toml')
  }

  return match[1]
}

const stopProcessMatches = async (label, pattern) => {
  const result = await tryRun('pgrep', ['-f', pattern], { capture: true })
  const currentPid = String(process.pid)
  const pids = result.ok
    ? result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((pid) => pid && pid !== currentPid)
    : []

  await killPids(label, [...new Set(pids)])
}

const disableSupabaseContainerRestarts = async () => {
  const projectId = getSupabaseProjectId()
  const result = await tryRun('docker', [
    'ps',
    '-aq',
    '--filter',
    `label=com.supabase.cli.project=${projectId}`
  ], { capture: true })

  if (!result.ok) {
    return
  }

  const containerIds = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (containerIds.length === 0) {
    return
  }

  console.log('Disabling Docker auto-restart for local Supabase containers...')
  await tryRun('docker', ['update', '--restart=no', ...containerIds])
}

const stopSupabase = async () => {
  console.log('Stopping Supabase...')
  const result = await tryRun('npm', ['run', 'supabase:stop'])

  if (result.ok) {
    return
  }

  console.error(result.stderr || result.stdout || result.message)
  throw new Error('Supabase did not stop cleanly.')
}

const printEndpointStatus = async () => {
  const checks = [
    ['App', `http://127.0.0.1:${appPort}/`],
    ['Supabase API', `http://127.0.0.1:${supabasePort}/auth/v1/settings`],
    ['Studio', `http://127.0.0.1:${studioPort}`],
    ['Mailpit', `http://127.0.0.1:${mailPort}`]
  ]

  console.log('\nLocal endpoint status')
  console.log('--------------------------------')

  for (const [label, url] of checks) {
    const running = await httpOk(url)
    const status = running ? 'RUN' : 'OFF'

    console.log(`${status} ${label.padEnd(14)} ${url}`)
  }
}

const main = async () => {
  await killPids('Agora dev server', await pidsListeningOnPort(appPort))
  await stopProcessMatches('Supabase Edge Functions', 'supabase functions serve')
  await disableSupabaseContainerRestarts()
  await stopSupabase()
  await printEndpointStatus()

  console.log('\nAll done.')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
