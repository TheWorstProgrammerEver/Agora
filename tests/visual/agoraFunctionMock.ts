import type { Page, Route } from '@playwright/test'
import type { AgoraRequestIdentifier } from '../../common/agoraRequestIdentifiers'

type AgoraFunctionRequest = {
  identifier: AgoraRequestIdentifier
  params: Record<string, unknown>
  version: number
}

type AgoraFunctionHandler = (
  identifier: AgoraRequestIdentifier,
  params: Record<string, unknown>
) => unknown | Promise<unknown>

const readRequest = (route: Route) => (
  JSON.parse(route.request().postData() ?? '{}') as AgoraFunctionRequest
)

export const routeAgoraFunction = async (page: Page, handler: AgoraFunctionHandler) => {
  await page.route('**/functions/v1/agora', async (route) => {
    const request = readRequest(route)

    try {
      const result = await handler(request.identifier, request.params)
      await route.fulfill({
        body: JSON.stringify(result),
        contentType: 'application/json',
        status: 200
      })
    } catch (error) {
      await route.fulfill({
        body: JSON.stringify({ error: error instanceof Error ? error.message : 'Mock request failed.' }),
        contentType: 'application/json',
        status: 400
      })
    }
  })
}
