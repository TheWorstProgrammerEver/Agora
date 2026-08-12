export class HandlerExecutionError extends Error {
  constructor(code) {
    super(`Agora handler failed (${code}).`)
    this.code = code
  }
}
