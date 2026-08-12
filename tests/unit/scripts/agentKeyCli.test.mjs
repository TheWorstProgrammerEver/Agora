import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { runCommand } from '../../../scripts/agent-keys/command.mjs'
import { elevatedNodeInvocation } from '../../../scripts/agent-keys/elevated-node.mjs'
import { fingerprintApplicationKey } from '../../../scripts/agent-keys/key-format.mjs'
import { runOperatorCommand } from '../../../scripts/agent-keys/operator-cli.mjs'
import { runCredentialCommand } from '../../../scripts/agent-keys/systemd-credential-cli.mjs'
import { createSystemdServiceControl } from '../../../scripts/agent-keys/systemd-service.mjs'
import { createReadinessReceipt } from '../../../scripts/agent-provisioning/readiness-receipt.mjs'

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
  const readyReceipt = () => createReadinessReceipt({
    artifactDigest: 'a'.repeat(64),
    operation: 'install',
    service: 'agora-agent-runner@test.service'
  })

  const readyRow = (principalId) => ({
    agent_principal_id: principalId,
    authorized_group_count: 1,
    is_active: true,
    live_key_count: 0,
    ready_for_initial_key: true
  })

  it('prepares a principal without issuing a key', async () => {
    const principalId = randomUUID()
    const client = {
      issueInitialKey: vi.fn(),
      prepareAgent: vi.fn(async () => [{
        agent_principal_id: principalId,
        display_name: 'Test agent'
      }])
    }
    const terminal = createTerminal(false)

    await runOperatorCommand(['prepare', 'Test agent'], { client, terminal })

    expect(client.prepareAgent).toHaveBeenCalledWith('Test agent')
    expect(client.issueInitialKey).not.toHaveBeenCalled()
    expect(terminal.output.join('')).not.toContain('agora_agent_v1_')
  })

  it('refuses non-interactive issuance after non-secret readiness without issuing a key', async () => {
    const principalId = randomUUID()
    const client = {
      getProvisioningReadiness: vi.fn(async () => [readyRow(principalId)]),
      issueInitialKey: vi.fn()
    }

    await expect(runOperatorCommand(['issue', principalId, '--host-readiness', readyReceipt()], {
      client,
      terminal: createTerminal(false)
    })).rejects.toMatchObject({
      code: 'operator_tty_required',
      stage: 'key_issuance'
    })
    expect(client.issueInitialKey).not.toHaveBeenCalled()
  })

  it('shows an issued key exactly once only on the restricted TTY', async () => {
    const applicationKey = createKey()
    const principalId = randomUUID()
    const terminal = createTerminal()
    const client = {
      getProvisioningReadiness: vi.fn(async () => [readyRow(principalId)]),
      issueInitialKey: vi.fn(async () => ({
        agent_principal_id: principalId,
        application_key: applicationKey,
        application_key_id: randomUUID(),
        key_fingerprint: fingerprintApplicationKey(applicationKey)
      }))
    }

    await runOperatorCommand(
      ['issue', principalId, '--host-readiness', readyReceipt()],
      { client, terminal }
    )

    expect(terminal.output.join('').split(applicationKey)).toHaveLength(2)
    expect(client.issueInitialKey).toHaveBeenCalledWith(principalId)
  })

  it('denies key issuance before group readiness', async () => {
    const principalId = randomUUID()
    const client = {
      getProvisioningReadiness: vi.fn(async () => [{
        ...readyRow(principalId),
        authorized_group_count: 0,
        ready_for_initial_key: false
      }]),
      issueInitialKey: vi.fn()
    }

    await expect(runOperatorCommand(
      ['issue', principalId, '--host-readiness', readyReceipt()],
      { client, terminal: createTerminal() }
    )).rejects.toMatchObject({
      code: 'authorized_group_required',
      stage: 'server_readiness'
    })
    expect(client.issueInitialKey).not.toHaveBeenCalled()
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
  it('elevates with the resolved absolute Node runtime instead of sudo PATH lookup', () => {
    const entrypoint = '/opt/agora/systemd-credential-cli.mjs'
    const invocation = elevatedNodeInvocation({
      args: ['commit'],
      entrypoint,
      nodePath: process.execPath,
      uid: 1000
    })

    expect(invocation.file).toBe('/usr/bin/sudo')
    expect(invocation.args).toEqual([
      '-n',
      '--',
      process.execPath,
      entrypoint,
      'commit'
    ])
  })

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
      ['reset-failed', 'agora-agent-runner.service'],
      ['restart', 'agora-agent-runner.service'],
      ['is-active', '--quiet', 'agora-agent-runner.service']
    ])
  })

  it('stops a failed activation and clears only the owned unit start limit', async () => {
    const run = vi.fn(async (_file, args) => {
      if (args.includes('GetUnit')) {
        return Buffer.from(JSON.stringify({
          type: 'o',
          data: ['/org/freedesktop/systemd1/unit/agora_2dagent_2drunner_40test_2eservice']
        }))
      }
      if (args.includes('LoadCredentialEncrypted')) {
        return Buffer.from(JSON.stringify({
          type: 'a(ss)',
          data: [['agora-agent-key', '/etc/credstore.encrypted/agora-agent-key.cred']]
        }))
      }
      if (args[0] === 'is-active') throw new Error('native failure must not escape')
      return Buffer.alloc(0)
    })
    const control = createSystemdServiceControl({
      run,
      service: 'agora-agent-runner@test.service'
    })

    await expect(control.activateAndValidate()).rejects.toThrow('native failure must not escape')
    expect(run.mock.calls.map(([, args]) => args).slice(-6)).toEqual([
      ['enable', 'agora-agent-runner@test.service'],
      ['restart', 'agora-agent-runner@test.service'],
      ['is-active', '--quiet', 'agora-agent-runner@test.service'],
      ['disable', 'agora-agent-runner@test.service'],
      ['stop', 'agora-agent-runner@test.service'],
      ['reset-failed', 'agora-agent-runner@test.service']
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
