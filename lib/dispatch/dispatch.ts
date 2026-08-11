export interface IRequest<TResult, TParams> {
  readonly identifier: string
  readonly resultType?: TResult
  readonly params: TParams
}

export type RequestHandler = (request: IRequest<unknown, unknown>) => unknown | Promise<unknown>

export type RequestHandlers = Record<string, RequestHandler>

export type RequestType<TResult, TParams> = {
  readonly identifier: string
  new (...[params]: TParams extends void ? [] : [TParams]): IRequest<TResult, TParams>
}

export type RequestHandlerRegistration = {
  readonly identifier: string
  readonly handler: RequestHandler
}

export const createQueryType = <TIdentifier extends string>(identifier: TIdentifier) =>
  <TResult, TParams = void>() =>
    class implements IRequest<TResult, TParams> {
      static readonly identifier = identifier
      readonly identifier = identifier
      declare readonly resultType?: TResult
      readonly params: TParams

      constructor(...[params]: TParams extends void ? [] : [TParams]) {
        this.params = params as TParams
      }
    }

export const createCommandType = <TIdentifier extends string>(identifier: TIdentifier) =>
  <TResult = void, TParams = void>() =>
    createQueryType(identifier)<TResult, TParams>()

export const createRequestHandler = <TResult, TParams>(
  requestType: RequestType<TResult, TParams>,
  handler: (request: IRequest<TResult, TParams>) => TResult | Promise<TResult>
): RequestHandlerRegistration => ({
  identifier: requestType.identifier,
  handler: handler as RequestHandler
})

export const createRequestHandlers = (registrations: RequestHandlerRegistration[]): RequestHandlers => (
  Object.fromEntries(registrations.map((registration) => [
    registration.identifier,
    registration.handler
  ]))
)

export const createDispatcher = (handlers: RequestHandlers) => ({
  dispatch: async <TResult, TParams>(request: IRequest<TResult, TParams>) => {
    const handler = handlers[request.identifier]

    if (!handler) {
      throw new Error(`Unsupported request ${request.identifier}`)
    }

    return await handler(request) as TResult
  }
})
