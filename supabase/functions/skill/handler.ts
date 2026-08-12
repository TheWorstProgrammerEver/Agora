type SkillArtifact = {
  bytes: Uint8Array
  etag: string
  filename: string
  version: string
}

const baseHeaders = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff'
}

const errorHeaders = {
  ...baseHeaders,
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8'
}

const errorResponse = (status: number, error: string, extraHeaders = {}) => new Response(
  JSON.stringify({ error }),
  { headers: { ...errorHeaders, ...extraHeaders }, status }
)

const requestIsMalformed = (request: Request) => {
  const url = new URL(request.url)
  const contentLength = request.headers.get('content-length')

  return url.pathname !== '/skill/codex'
    || url.search.length > 0
    || request.headers.has('transfer-encoding')
    || (contentLength !== null && contentLength !== '0')
}

const etagMatches = (header: string | null, etag: string) => header
  ?.split(',')
  .map((candidate) => candidate.trim())
  .some((candidate) => (
    candidate === '*' || candidate.replace(/^W\//, '') === etag
  )) ?? false

export const createSkillHandler = (artifact: SkillArtifact) => async (request: Request) => {
  if (request.method !== 'GET') {
    return errorResponse(405, 'Method not allowed.', { allow: 'GET' })
  }

  if (requestIsMalformed(request)) {
    return errorResponse(400, 'Skill request is invalid.')
  }

  const artifactHeaders = {
    ...baseHeaders,
    'content-disposition': `attachment; filename="${artifact.filename}"`,
    'content-type': 'application/zip',
    'content-version': artifact.version,
    etag: artifact.etag
  }

  if (etagMatches(request.headers.get('if-none-match'), artifact.etag)) {
    return new Response(null, { headers: artifactHeaders, status: 304 })
  }

  const body = new ArrayBuffer(artifact.bytes.byteLength)
  new Uint8Array(body).set(artifact.bytes)

  return new Response(body, { headers: artifactHeaders, status: 200 })
}
