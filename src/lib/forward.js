import crypto from 'crypto';

const url = process.env.SCRAPLET_WEBHOOK_URL;
const secret = process.env.SCRAPLET_SHARED_SECRET;
const TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 2000);

export async function forwardEvent(kind, body) {
  if (!url || !secret) return; // silently skip if unset
  const json = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(json).digest('hex');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraplet-Signature': sig
      },
      body: json,
      signal: ctrl.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[forward]', kind, res.status, txt.slice(0,200));
    }
  } catch (e) {
    console.warn('[forward]', kind, 'error', e.message || e);
  } finally {
    clearTimeout(t);
  }
}
