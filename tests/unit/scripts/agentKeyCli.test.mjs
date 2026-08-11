import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { runCommand } from '../../../scripts/agent-keys/command.mjs'
import { fingerprintApplicationKey } from '../../../scripts/agent-keys/key-format.mjs'
import { runOperatorCommand } from '../../../scripts/agent-keys/operator-cli.mjs'
import { runCredentialCommand } from '../../../scripts/agent-keys/systemd-credential-cli.mjs'
import { createSystemdServiceControl } from '../../../scripts/agent-keys/systemd-service.mjs'

const createKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`

const createTerminal = (isTTY = true) => {
  const output = []

  return {
    isTTY,
    output,
    write: (value) => output.push(value)
  }
}

describe('operator agent-key CLI', () => {
  it('refuses non-interactive issuance before calling the operator API', async () => {
    const client = { provisionAgent: vi.fn() }

    await expect(runOperatorCommand(['provision', 'Test agent'], {
      client,
      terminal: createTerminal(false)
    })).rejects.toThrow('interactive operator TTY')
    expect(client.provisionAgent).not.toHaveBeenCalled()
  })

  it('shows an issued key exactly once only on the restricted TTY', async () => {
    const applicationKey = createKey()
    const terminal = createTerminal()
    const client = {
      provisionAgent: vi.fn(async () => ({
        agent_principal_id: randomUUID(),
        application_key: applicationKey,
        application_key_id: randomUUID(),
        key_fingerprint: fingerprintApplicationKey(applicationKey)
      }))
    }

    await runOperatorCommand(['provision', 'Test agent'], { client, terminal })

    expect(terminal.output.join('').split(applicationKey)).toHaveLength(2)
    expect(client.provisionAgent).toHaveBeenCalledWith('Test agent')
  })

  it('completes rotation using only audit-safe identifiers', async () => {
    const terminal = createTerminal(false)
    const client = { completeRotation: vi.fn(async () => {}) }
    const keyId = randomUUID()
    const fingerprint = 'sha256:0123456789abcdef'

    await runOperatorCommand(
      ['rotate-complete', keyId, fingerprint],
      { client, terminal }
    )

    expect(client.completeRotation).toHaveBeenCalledWith(keyId, fingerprint)
    expect(terminal.output.join('')).not.toContain('agora_agent_v1_')
  })
})

describe('host agent-key CLI', () => {
  it('passes the raw key only as an in-memory buffer and zeroes it after install', async () => {
    const applicationKey = createKey()
    const secret = Buffer.from(applicationKey)
    const fingerprint = fingerprintApplicationKey(applicationKey)
    const terminal = createTerminal(false)
    const store = {
      install: vi.fn(async (value, expected) => {
        expect(value.toString('utf8')).toBe(applicationKey)
        expect(expected).toBe(fingerprint)
        return fingerprint
      })
    }

    await runCredentialCommand([
      'install',
      '--service',
      'agora-agent-runner.service',
      '--fingerprint',
      fingerprint
    ], {
      createServiceControl: () => ({ restartAndValidate: vi.fn() }),
      createStore: () => store,
      getUid: () => 0,
      readSecret: async () => secret,
      write: terminal.write
    })

    expect(secret.equals(Buffer.alloc(secret.length))).toBe(true)
    expect(terminal.output.join('')).not.toContain(applicationKey)
  })

  it('refuses host custody work outside root', async () => {
    await expect(runCredentialCommand(['commit'], {
      getUid: () => 1000
    })).rejects.toThrow('must run as root')
  })

  it('requires the exact encrypted-credential binding before restarting', async () => {
    const run = vi.fn(async (_file, args) => {
      if (args.includes('GetUnit')) {
        return Buffer.from(JSON.stringify({
          type: 'o',
          data: ['/org/freedesktop/systemd1/unit/agora_2dagent_2drunner_2eservice']
        }))
      }

      if (args.includes('LoadCredentialEncrypted')) {
        return Buffer.from(JSON.stringify({
          type: 'a(ss)',
          data: [['agora-agent-key', '/etc/credstore.encrypted/agora-agent-key.cred']]
        }))
      }

      return Buffer.alloc(0)
    })
    const control = createSystemdServiceControl({
      run,
      service: 'agora-agent-runner.service'
    })

    await control.restartAndValidate()

    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ['daemon-reload'],
      [
        '--json=short',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'GetUnit',
        's',
        'agora-agent-runner.service'
      ],
      [
        '--json=short',
        'get-property',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/agora_2dagent_2drunner_2eservice',
        'org.freedesktop.systemd1.Service',
        'LoadCredentialEncrypted'
      ],
      ['restart', 'agora-agent-runner.service'],
      ['is-active', '--quiet', 'agora-agent-runner.service']
    ])
  })

  it('refuses to restart a service with another credential path', async () => {
    const run = vi.fn(async (_file, args) => Buffer.from(JSON.stringify(
      args.includes('GetUnit')
        ? {
            type: 'o',
            data: ['/org/freedesktop/systemd1/unit/agora_2dagent_2drunner_2eservice']
          }
        : {
            type: 'a(ss)',
            data: [['agora-agent-key', '/tmp/alternate-supervisor-file']]
          }
    )))
    const control = createSystemdServiceControl({
      run,
      service: 'agora-agent-runner.service'
    })

    await expect(control.restartAndValidate()).rejects.toThrow(
      'approved encrypted credential path'
    )
    expect(run).toHaveBeenCalledTimes(3)
  })
})

describe('secret-bearing command projection', () => {
  it('does not return child stderr when a stdin secret is rejected', async () => {
    const marker = `agora_agent_v1_${randomBytes(32).toString('base64url')}`

    await expect(runCommand('/usr/bin/node', [
      '-e',
      'process.stdin.pipe(process.stderr); process.stdin.on("end", () => process.exit(7))'
    ], { input: Buffer.from(marker) })).rejects.not.toThrow(marker)
  })
})
