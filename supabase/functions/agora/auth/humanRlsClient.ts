import { createRlsClient } from './rlsClient.ts'

export const createHumanRlsClient = (accessToken: string) => createRlsClient({
  authorization: `Bearer ${accessToken}`
})
