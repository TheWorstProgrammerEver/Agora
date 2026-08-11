import { spawn } from 'node:child_process'
import { platform } from 'node:os'

const waitForChildExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true)
    return
  }

  const onExit = () => {
    clearTimeout(timeout)
    resolve(true)
  }
  const timeout = setTimeout(() => {
    child.off('exit', onExit)
    resolve(false)
  }, timeoutMs)

  child.once('exit', onExit)
})

const signalManagedProcess = (child, signal) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  if (platform() !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error
      }
    }
  }

  if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
    throw new Error('Process signal was not accepted.')
  }
}

const terminateManagedProcess = async ({ child, label }) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  console.log(`Stopping ${label}...`)
  signalManagedProcess(child, 'SIGTERM')

  if (await waitForChildExit(child, 5000)) {
    return
  }

  signalManagedProcess(child, 'SIGKILL')

  if (!await waitForChildExit(child, 5000)) {
    throw new Error(`${label} did not terminate within the shutdown deadline.`)
  }
}

export const startManagedProcess = (processes, label, command, args) => {
  console.log(`Starting ${label}...`)
  const child = spawn(command, args, {
    detached: platform() !== 'win32',
    stdio: 'inherit',
    shell: false
  })

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`${label} exited with code ${code}`)
    }
  })

  processes.push({ child, label })
}

export const stopManagedProcesses = async (managedProcesses) => {
  const processes = managedProcesses.splice(0)
  const results = await Promise.allSettled(processes.map(terminateManagedProcess))
  const failures = results.filter((result) => result.status === 'rejected')

  if (failures.length > 0) {
    throw new Error(failures.map((failure) => failure.reason.message).join('\n'))
  }
}
