import { createHmac, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  agoraRealtimeAgentRole,
  realtimeSessionLifetimeSeconds,
  realtimeSessionRefreshLeadSeconds
} from '../../../../common/agoraRealtime'
import { createRealtimeCredentialIssuer } from '../../../../supabase/functions/agora/handlers/realtime/credential'

const decodePart = (part: string) => JSON.parse(
  Buffer.from(part, 'base64url').toString('utf8')
) as Record<string, unknown>

describe('Agora Realtime credential issuer', () => {
  it('mints bounded local credentials with only agent and topic authorization claims', async () => {
    const principalId = randomUUID()
    const groupIds = [randomUUID(), randomUUID()]
    const now = Date.parse('2026-08-12T02:00:00.000Z')
    const localSecret = 'local-test-signing-secret-without-production-value'
    const tokenId = randomUUID()
    const issuer = createRealtimeCredentialIssuer({
      createTokenId: () => tokenId,
      getEnvironment: (name) => name === 'AGORA_REALTIME_LOCAL_SIGNING_SECRET'
        ? localSecret
        : undefined,
      now: () => now
    })
    const credential = await issuer({ groupIds, principalId })
    const [headerPart, claimsPart, signaturePart] = credential.accessToken.split('.')
    const header = decodePart(headerPart)
    const claims = decodePart(claimsPart)
    const expectedSignature = createHmac('sha256', localSecret)
      .update(`${headerPart}.${claimsPart}`)
      .digest('base64url')

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(signaturePart).toBe(expectedSignature)
    expect(claims).toEqual({
      agora_principal_id: principalId,
      agora_realtime_topics: groupIds,
      agora_token_kind: 'realtime',
      exp: now / 1000 + realtimeSessionLifetimeSeconds,
      iat: now / 1000,
      jti: tokenId,
      role: agoraRealtimeAgentRole,
      sub: principalId
    })
    expect(credential).toMatchObject({
      expiresAt: new Date(now + realtimeSessionLifetimeSeconds * 1000).toISOString(),
      refreshAfter: new Date(
        now + (realtimeSessionLifetimeSeconds - realtimeSessionRefreshLeadSeconds) * 1000
      ).toISOString()
    })
    expect(JSON.stringify(claims)).not.toContain(localSecret)
  })

  it('uses an imported ES256 private key without projecting key material', async () => {
    const generatedKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const privateJwk = await crypto.subtle.exportKey('jwk', generatedKey.privateKey)
    const signingJwk = { ...privateJwk, alg: 'ES256', kid: 'agora-realtime-test-key' }
    const issuer = createRealtimeCredentialIssuer({
      getEnvironment: (name) => name === 'AGORA_REALTIME_SIGNING_JWK'
        ? JSON.stringify(signingJwk)
        : undefined,
      now: () => Date.parse('2026-08-12T02:00:00.000Z')
    })
    const credential = await issuer({ groupIds: [randomUUID()], principalId: randomUUID() })
    const [headerPart, claimsPart, signaturePart] = credential.accessToken.split('.')
    const verified = await crypto.subtle.verify(
      { hash: 'SHA-256', name: 'ECDSA' },
      generatedKey.publicKey,
      Buffer.from(signaturePart, 'base64url'),
      new TextEncoder().encode(`${headerPart}.${claimsPart}`)
    )

    expect(decodePart(headerPart)).toEqual({
      alg: 'ES256',
      kid: 'agora-realtime-test-key',
      typ: 'JWT'
    })
    expect(verified).toBe(true)
    expect(credential.accessToken).not.toContain(privateJwk.d as string)
  })

  it('fails closed for missing or malformed signing configuration', async () => {
    const input = { groupIds: [randomUUID()], principalId: randomUUID() }

    await expect(createRealtimeCredentialIssuer({
      getEnvironment: () => undefined
    })(input)).rejects.toThrow('Agora Realtime signing key configuration is missing.')
    await expect(createRealtimeCredentialIssuer({
      getEnvironment: (name) => name === 'AGORA_REALTIME_SIGNING_JWK' ? '{}' : undefined
    })(input)).rejects.toThrow('Agora Realtime signing key configuration is invalid.')
  })
})
