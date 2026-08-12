import {
  agoraRealtimeEvent,
  formatAgoraRealtimeTopic
} from '../../../common/agoraRealtime'
import { supabase } from '../supabaseClient'
import {
  parseGroupAvailabilityHint,
  type GroupAvailabilityHint
} from './groupAvailabilityPayload'

type AvailabilityCallbacks = {
  onConnected: () => void
  onDisconnected: () => void
  onHint: (hint: GroupAvailabilityHint) => void
}

export const subscribeToGroupAvailability = (
  groupId: string,
  callbacks: AvailabilityCallbacks
) => {
  let active = true
  const channel = supabase
    .channel(formatAgoraRealtimeTopic(groupId), {
      config: { broadcast: { ack: false }, private: true }
    })
    .on('broadcast', { event: agoraRealtimeEvent }, ({ payload }) => {
      const hint = parseGroupAvailabilityHint(payload)

      if (active && hint?.groupId === groupId) {
        callbacks.onHint(hint)
      }
    })

  void supabase.realtime.setAuth()
    .then(() => {
      if (!active) {
        return
      }

      channel.subscribe((status) => {
        if (!active) {
          return
        }

        if (status === 'SUBSCRIBED') {
          callbacks.onConnected()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          callbacks.onDisconnected()
        }
      })
    })
    .catch(() => {
      if (active) {
        callbacks.onDisconnected()
      }
    })

  return () => {
    active = false
    void supabase.removeChannel(channel)
  }
}
