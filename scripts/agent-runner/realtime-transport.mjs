import { createClient } from '@supabase/supabase-js'
import { RunnerCanceledError, throwIfAborted } from './abort.mjs'
import { hasExactKeys, isObject, isSequence, isUuid } from './value-validation.mjs'

const subscribeTimeoutMs = 10_000
const cleanupTimeoutMs = 5_000

const removeChannels = async (client) => {
  let timer
  try {
    await Promise.race([
      client.removeAllChannels(),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Agora Realtime cleanup timed out.')),
          cleanupTimeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(timer)
    client.realtime.disconnect()
  }
}

export const validateAvailability = (value, expectedGroupId) => (
  isObject(value)
  && hasExactKeys(value, ['groupId', 'highWatermarkSequence', 'id'])
  && value.groupId === expectedGroupId
  && isUuid(value.groupId)
  && isSequence(value.highWatermarkSequence)
  && typeof value.id === 'string'
  && value.id.length > 0
  && value.id.length <= 200
)

const subscribeChannel = (channel, signal, onUnavailable) => new Promise((resolve, reject) => {
  throwIfAborted(signal)
  let settled = false
  const finish = (callback) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    callback()
  }
  const onAbort = () => finish(() => reject(new RunnerCanceledError()))
  const timer = setTimeout(
    () => finish(() => reject(new Error('Agora Realtime subscription timed out.'))),
    subscribeTimeoutMs
  )

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      finish(resolve)
    } else if (['CHANNEL_ERROR', 'CLOSED', 'TIMED_OUT'].includes(status)) {
      if (settled) {
        onUnavailable()
      } else {
        finish(() => reject(new Error('Agora Realtime subscription failed.')))
      }
    }
  })
})

const createSessionConnection = async ({
  onDisconnect,
  onWatermark,
  publishableKey,
  session,
  signal,
  supabaseUrl
}) => {
  const client = createClient(supabaseUrl, publishableKey, {
    accessToken: async () => session.accessToken,
    auth: { autoRefreshToken: false, persistSession: false }
  })
  await client.realtime.setAuth(session.accessToken)
  let closing = false
  const channels = session.topics.map(({ groupId, topic }) => (
    client
      .channel(topic, { config: { broadcast: { ack: true }, private: true } })
      .on('broadcast', { event: 'message_available' }, ({ payload }) => {
        if (!validateAvailability(payload, groupId)) {
          if (!closing) onDisconnect('event_invalid')
          return
        }
        void onWatermark(groupId, payload.highWatermarkSequence).catch(() => {
          if (!closing) onDisconnect('state_unavailable')
        })
      })
  ))

  try {
    await Promise.all(channels.map((channel) => subscribeChannel(
      channel,
      signal,
      () => {
        if (!closing) onDisconnect('channel_unavailable')
      }
    )))
  } catch (error) {
    closing = true
    await removeChannels(client).catch(() => undefined)
    throw error
  }

  return async () => {
    closing = true
    await removeChannels(client)
  }
}

export const connectRealtime = async (options) => {
  if (!options.supabaseUrl || !options.publishableKey) {
    throw new Error('Agora Realtime configuration is required.')
  }

  const cleanup = []
  try {
    for (const session of options.sessions) {
      cleanup.push(await createSessionConnection({ ...options, session }))
    }
  } catch (error) {
    await Promise.allSettled(cleanup.map((close) => close()))
    throw error
  }

  return async () => {
    const results = await Promise.allSettled(cleanup.map((close) => close()))
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Agora Realtime cleanup failed.')
    }
  }
}

export const earliestRefreshAt = (sessions) => Math.min(
  ...sessions.map(({ refreshAfter }) => Date.parse(refreshAfter))
)
