import { spawn } from 'node:child_process'

const childEnvironment = {
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin'
}

export const runCommand = (file, args, { input, output = 'ignore' } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    env: childEnvironment,
    stdio: ['pipe', output === 'buffer' ? 'pipe' : 'ignore', 'pipe']
  })
  const stdout = []

  child.stdout?.on('data', (chunk) => stdout.push(chunk))
  child.stderr.resume()
  child.stdin.on('error', () => {})
  child.on('error', () => reject(new Error('Required host command could not be started.')))
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`Required host command failed with exit code ${code}.`))
      return
    }

    resolve(Buffer.concat(stdout))
  })

  if (input) {
    child.stdin.end(input)
  } else {
    child.stdin.end()
  }
})
