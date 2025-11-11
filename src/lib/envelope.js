import { randomUUID } from 'crypto';

export function buildEvent({ kind, channel, actor, data, raw }) {
  return {
    v: 1,
    id: 'evt_' + randomUUID(),
    source: 'kick',
    kind,
    ts: new Date().toISOString(),
    channel: {
      slug: channel?.slug || '',
      chatroom_id: channel?.chatroom_id ?? null
    },
    actor: {
      id: String(actor?.id || ''),
      username: String(actor?.username || '')
    },
    data: data || {},
    // keep raw only if explicitly requested
    raw: process.env.FORWARD_INCLUDE_RAW === 'true' ? raw : undefined
  };
}
