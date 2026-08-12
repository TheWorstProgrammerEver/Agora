#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { runApiCommand } from './api-command.mjs'

export const main = async (
  args = process.argv.slice(2),
  environment = process.env
) => {
  process.umask(0o077)
  await runApiCommand(args, environment)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('{"code":"context_unavailable"}\n')
    process.exitCode = 1
  })
}
