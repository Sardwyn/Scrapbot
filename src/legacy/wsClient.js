import WebSocket from 'ws';
import { refreshIfNeeded } from './refreshKick.js';

/**
 * Connect to a Kick-style raw WS.
 * If slugOrOwner is provided, we will JIT-refresh a token and:
 *  - add Authorization header (Node ws supports headers)
 *  - also append ?token=… if the URL doesn't already have a token
 */
export function connectKickWS({ url, slugOrOwner = null, headers = {}, onOpen, onMessage, onClose, onError }) {
  let ws;

  async function open() {
    let finalHeaders = { ...headers };
    let finalUrl = url;

    if (slugOrOwner) {
      try {
        const { access_token, token_type } = await refreshIfNeeded(slugOrOwner);
        finalHeaders.Authorization = `${token_type || 'Bearer'} ${access_token}`;
        if (!/[?&](token|access_token)=/i.test(finalUrl)) {
          finalUrl += (finalUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(access_token)}`;
        }
      } catch (e) {
        // Proceed without token if refresh fails
        // (server may still accept unauthenticated for public feeds)
      }
    }

    ws = new WebSocket(finalUrl, { headers: finalHeaders });
    ws.on('open', () => onOpen && onOpen());
    ws.on('message', (d) => onMessage && onMessage(d.toString()));
    ws.on('close', (c) => onClose && onClose(c));
    ws.on('error', (e) => onError && onError(e));
    return ws;
  }

  return { open };
}
