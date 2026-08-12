import type { Page, WebSocketRoute } from '@playwright/test'
import { agoraRealtimeEvent, formatAgoraRealtimeTopic } from '../../common/agoraRealtime'

type PhoenixMessage = [string | null, string | null, string, string, Record<string, unknown>]

type Connection = {
  join?: PhoenixMessage
  socket: WebSocketRoute
}

const parseMessage = (message: string | Buffer) => {
  if (typeof message !== 'string') {
    return
  }

  const value = JSON.parse(message) as unknown

  if (!Array.isArray(value) || value.length !== 5) {
    return
  }

  return value as PhoenixMessage
}

const reply = (connection: Connection, message: PhoenixMessage) => {
  const [joinRef, ref, topic] = message
  connection.socket.send(JSON.stringify([
    joinRef,
    ref,
    topic,
    'phx_reply',
    { response: {}, status: 'ok' }
  ]))
}

export const routeAgoraRealtime = async (page: Page) => {
  const connections: Connection[] = []
  let acknowledgeJoins = true

  await page.routeWebSocket('**/realtime/v1/websocket**', (socket) => {
    const connection = { socket } as Connection
    connections.push(connection)

    socket.onMessage((rawMessage) => {
      const message = parseMessage(rawMessage)

      if (!message) {
        return
      }

      const [joinRef, ref, topic, event] = message

      if (event === 'phx_join') {
        connection.join = message

        if (acknowledgeJoins) {
          reply(connection, message)
        }
      } else if (event === 'heartbeat') {
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {
          response: {},
          status: 'ok'
        }]))
      }
    })
  })

  const latestConnection = () => {
    const connection = connections.at(-1)

    if (!connection) {
      throw new Error('Agora Realtime did not open a WebSocket connection.')
    }

    return connection
  }

  return {
    acknowledgeLatestJoin: () => {
      const connection = latestConnection()

      if (!connection.join) {
        throw new Error('Agora Realtime did not send a channel join request.')
      }

      reply(connection, connection.join)
    },
    connectionCount: () => connections.length,
    disconnectLatest: () => latestConnection().socket.close({
      code: 1012,
      reason: 'Playwright Realtime interruption'
    }),
    joinedConnectionCount: () => connections.filter(({ join }) => Boolean(join)).length,
    pauseJoinAcknowledgements: () => {
      acknowledgeJoins = false
    },
    sendAvailabilityHint: (groupId: string, highWatermarkSequence: string) => {
      latestConnection().socket.send(JSON.stringify([
        null,
        null,
        formatAgoraRealtimeTopic(groupId),
        'broadcast',
        {
          event: agoraRealtimeEvent,
          payload: { groupId, highWatermarkSequence },
          type: 'broadcast'
        }
      ]))
    }
  }
}
