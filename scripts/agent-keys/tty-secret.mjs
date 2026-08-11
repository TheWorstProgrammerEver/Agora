export const readSecretFromTty = ({
  input = process.stdin,
  output = process.stderr,
  prompt = 'Agora agent key: '
} = {}) => new Promise((resolve, reject) => {
  if (!input.isTTY || typeof input.setRawMode !== 'function' || !output.isTTY) {
    reject(new Error('Agora agent keys must be entered through an interactive TTY.'))
    return
  }

  const chunks = []
  const initialRawMode = Boolean(input.isRaw)
  let settled = false

  const clearChunks = () => {
    for (const chunk of chunks) {
      chunk.fill(0)
    }
  }

  const finish = (error) => {
    if (settled) {
      return
    }

    settled = true
    input.off('data', onData)
    input.off('end', onEnd)
    input.off('error', onError)
    let cleanupFailed = false

    try {
      input.setRawMode(initialRawMode)
      input.pause()
      output.write('\n')
    } catch {
      cleanupFailed = true
    }

    if (error || cleanupFailed) {
      clearChunks()
      reject(cleanupFailed
        ? new Error('Agora agent key TTY state could not be restored.')
        : error)
      return
    }

    const secret = Buffer.concat(chunks)
    clearChunks()
    resolve(secret)
  }
  const onEnd = () => finish(new Error('Agora agent key entry ended unexpectedly.'))
  const onError = () => finish(new Error('Agora agent key entry failed.'))
  const onData = (chunk) => {
    for (const byte of chunk) {
      if (byte === 3) {
        finish(new Error('Agora agent key entry was cancelled.'))
        return
      }

      if (byte === 10 || byte === 13) {
        finish()
        return
      }

      if (byte === 8 || byte === 127) {
        chunks.pop()?.fill(0)
        continue
      }

      if (chunks.length >= 256) {
        finish(new Error('Agora agent key input is too long.'))
        return
      }

      chunks.push(Buffer.from([byte]))
    }
  }

  try {
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
    output.write(prompt)
  } catch {
    finish(new Error('Agora agent key TTY could not be initialized.'))
  }
})
