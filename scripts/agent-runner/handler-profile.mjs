const complexTerms = /\b(?:architecture|authorization|concurren|credential|debug|deploy|incident|migration|privacy|production|security|systemd|transaction)\b/i
const codeSignals = /```|\b(?:bash|css|html|javascript|json|postgres|python|react|sql|typescript)\b/i

export const selectHandlerProfile = (messages, config) => {
  const text = messages.map((message) => message.text).join('\n')
  const complex = messages.length >= 8
    || text.length >= 12_000
    || complexTerms.test(text)
    || codeSignals.test(text)

  if (complex) {
    return {
      model: config.complexModel,
      reasoningEffort: text.length >= 24_000 || complexTerms.test(text) ? 'xhigh' : 'high'
    }
  }

  return {
    model: config.standardModel,
    reasoningEffort: messages.length <= 2 && text.length < 1000 ? 'low' : 'medium'
  }
}
