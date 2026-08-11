(() => {
  const configuredConfigFile = '#{CONFIG_FILE}#'
  const isSubstituted = (value) => value && !value.includes('#{')
  const normalizePath = (path) => path.startsWith('/') ? path : `/${path}`
  const loadConfig = (path) => {
    const request = new XMLHttpRequest()

    request.open('GET', path, false)
    request.send()

    if (request.status < 200 || request.status >= 300) {
      throw new Error(`${path} returned ${request.status}`)
    }

    return JSON.parse(request.responseText)
  }
  const candidates = [
    isSubstituted(configuredConfigFile) ? normalizePath(configuredConfigFile) : '/config.local.json'
  ].filter(Boolean)
  const failures = []

  for (const candidate of candidates) {
    try {
      window.config = loadConfig(candidate)
      return
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`)
    }
  }

  throw new Error(`App config could not be loaded. Tried ${failures.join(', ')}`)
})()
