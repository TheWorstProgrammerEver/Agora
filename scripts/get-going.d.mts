export type FunctionRouteResult = {
  error?: string
  status?: number
}

export type FunctionRouteStatus = {
  functionName: string
  result: FunctionRouteResult
  url?: string
}

export const getEnabledFunctionNames: () => string[]
export const isFunctionRouteReady: (
  functionName: string,
  result: FunctionRouteResult
) => boolean
export const areFunctionRoutesReady: (statuses: FunctionRouteStatus[]) => boolean
