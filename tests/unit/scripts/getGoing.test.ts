import { describe, expect, it } from 'vitest'
import {
  areFunctionRoutesReady,
  getEnabledFunctionNames,
  isFunctionRouteReady
} from '../../../scripts/get-going.mjs'

describe('get-going function route checks', () => {
  it('discovers every configured foundation route', () => {
    expect(getEnabledFunctionNames().sort()).toEqual(['agora', 'app-health'])
  })

  it('requires health success and accepts a mounted POST-only route', () => {
    expect(isFunctionRouteReady('app-health', { status: 200 })).toBe(true)
    expect(isFunctionRouteReady('app-health', { status: 405 })).toBe(false)
    expect(isFunctionRouteReady('agora', { status: 405 })).toBe(true)
    expect(isFunctionRouteReady('agora', { status: 404 })).toBe(false)
    expect(isFunctionRouteReady('agora', { status: 503 })).toBe(false)

    expect(areFunctionRoutesReady([
      { functionName: 'app-health', result: { status: 200 } },
      { functionName: 'agora', result: { status: 405 } }
    ])).toBe(true)
  })
})
