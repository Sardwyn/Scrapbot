import WebSocket from 'ws';
export function connectKickWS({ url, headers={}, onOpen, onMessage, onClose, onError }) {
  let ws;
  function open() {
    ws = new WebSocket(url, { headers });
    ws.on('open', () => onOpen && onOpen());
    ws.on('message', (d) => onMessage && onMessage(d.toString()));
    ws.on('close', (c) => onClose && onClose(c));
    ws.on('error', (e) => onError && onError(e));
    return ws;
  }
  return { open };
}
