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
  const finish = (error) => {
    input.off('data', onData)
    input.setRawMode(false)
    input.pause()
    output.write('\n')

    if (error) {
      for (const chunk of chunks) {
        chunk.fill(0)
      }
      reject(error)
      return
    }

    const secret = Buffer.concat(chunks)

    for (const chunk of chunks) {
      chunk.fill(0)
    }
    resolve(secret)
  }
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

  output.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
})
