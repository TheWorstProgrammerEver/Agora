#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { runAsRoot } from '../agent-keys/elevated-node.mjs'

const entrypoint = fileURLToPath(new URL('./host-cli.mjs', import.meta.url))

runAsRoot({ args: process.argv.slice(2), entrypoint }).then(
  (code) => { process.exitCode = code },
  () => {
    process.stderr.write('{"code":"host_elevation_failed","event":"provisioning_failed","recovery":"sudo -n true","stage":"host_elevation"}\n')
    process.exitCode = 1
  }
)
