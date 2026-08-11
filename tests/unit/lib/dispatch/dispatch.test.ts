import { describe, expect, it } from 'vitest'
import {
  createCommandType,
  createDispatcher,
  createQueryType,
  createRequestHandler,
  createRequestHandlers
} from '../../../../lib/dispatch/dispatch'

const expectString = (value: string) => value
const expectVoid = (value: void) => value

describe('dispatch', () => {
  it('routes requests by identifier and infers query result types', async () => {
    const GetNameQuery = createQueryType('getName')<string, { id: string }>()
    const dispatcher = createDispatcher(createRequestHandlers([
      createRequestHandler(GetNameQuery, (request) => `Ryan ${request.params.id}`)
    ]))

    const result = await dispatcher.dispatch(new GetNameQuery({ id: '1' }))

    expect(GetNameQuery.identifier).toBe('getName')
    expect(expectString(result)).toBe('Ryan 1')
  })

  it('defaults command result types to void', async () => {
    const SaveNameCommand = createCommandType('saveName')<void, { name: string }>()
    const dispatcher = createDispatcher(createRequestHandlers([
      createRequestHandler(SaveNameCommand, (request) => {
        expect(request.params.name).toBe('Ryan')
      })
    ]))

    const result = await dispatcher.dispatch(new SaveNameCommand({ name: 'Ryan' }))

    expect(expectVoid(result)).toBeUndefined()
  })
})
