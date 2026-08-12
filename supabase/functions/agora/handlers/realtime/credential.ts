import {
  agoraRealtimeAgentRole,
  realtimeSessionLifetimeSeconds,
  realtimeSessionRefreshLeadSeconds
} from '../../../../../common/agoraRealtime.ts'

export type RealtimeCredential = {
  accessToken: string
  expiresAt: string
  refreshAfter: string
}

export type RealtimeCredentialIssuer = (input: {
  groupIds: string[]
  principalId: string
}) => Promise<RealtimeCredential>

type CredentialIssuerOptions = {
  createTokenId?(): string
  getEnvironment?(name: string): string | undefined
  now?(): number
}

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const encodeJson = (value: unknown) => encodeBase64Url(
  new TextEncoder().encode(JSON.stringify(value))
)

const parseSigningJwk = (serialized: string) => {
  let value: unknown

  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Agora Realtime signing key configuration is invalid.')
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agora Realtime signing key configuration is invalid.')
  }

  const jwk = value as Record<string, unknown>
  const requiredStrings = ['d', 'kid', 'x', 'y']

  if (jwk.kty !== 'EC'
    || jwk.crv !== 'P-256'
    || (jwk.alg !== undefined && jwk.alg !== 'ES256')
    || requiredStrings.some((field) => (
      typeof jwk[field] !== 'string' || jwk[field] === ''
    ))) {
    throw new Error('Agora Realtime signing key configuration is invalid.')
  }

  return jwk as unknown as JsonWebKey & { kid: string }
}

const getRuntimeEnvironment = (name: string) => {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(name: string): string | undefined } }
  }

  return runtime.Deno?.env.get(name)
}

const signHmac = async (content: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content)))
}

const signEc = async (content: string, jwk: JsonWebKey) => {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )

  return new Uint8Array(await crypto.subtle.sign(
    { hash: 'SHA-256', name: 'ECDSA' },
    key,
    new TextEncoder().encode(content)
  ))
}

export const createRealtimeCredentialIssuer = ({
  createTokenId = () => crypto.randomUUID(),
  getEnvironment = getRuntimeEnvironment,
  now = Date.now
}: CredentialIssuerOptions = {}): RealtimeCredentialIssuer => async ({
  groupIds,
  principalId
}) => {
  const issuedAt = Math.floor(now() / 1000)
  const expiresAt = issuedAt + realtimeSessionLifetimeSeconds
  const claims = {
    agora_principal_id: principalId,
    agora_realtime_topics: groupIds,
    agora_token_kind: 'realtime',
    exp: expiresAt,
    iat: issuedAt,
    jti: createTokenId(),
    role: agoraRealtimeAgentRole,
    sub: principalId
  }
  const localSigningSecret = getEnvironment('AGORA_REALTIME_LOCAL_SIGNING_SECRET')
  const serializedJwk = getEnvironment('AGORA_REALTIME_SIGNING_JWK')
  const jwk = serializedJwk ? parseSigningJwk(serializedJwk) : undefined

  if (!localSigningSecret && !jwk) {
    throw new Error('Agora Realtime signing key configuration is missing.')
  }

  const header = jwk
    ? { alg: 'ES256', kid: jwk.kid, typ: 'JWT' }
    : { alg: 'HS256', typ: 'JWT' }
  const content = `${encodeJson(header)}.${encodeJson(claims)}`
  const signature = jwk
    ? await signEc(content, jwk)
    : await signHmac(content, localSigningSecret as string)

  return {
    accessToken: `${content}.${encodeBase64Url(signature)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    refreshAfter: new Date(
      (expiresAt - realtimeSessionRefreshLeadSeconds) * 1000
    ).toISOString()
  }
}

export const issueRealtimeCredential = createRealtimeCredentialIssuer()
