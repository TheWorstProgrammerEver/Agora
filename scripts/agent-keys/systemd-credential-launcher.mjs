#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { runAsRoot } from './elevated-node.mjs'

const entrypoint = fileURLToPath(
  new URL('./systemd-credential-cli.mjs', import.meta.url)
)

runAsRoot({
  args: process.argv.slice(2),
  entrypoint
}).then(
  (code) => { process.exitCode = code },
  (error) => {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 1
  }
)
