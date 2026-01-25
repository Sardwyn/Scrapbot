import crypto from 'crypto';

const url = process.env.SCRAPLET_WEBHOOK_URL;
const secret = process.env.SCRAPLET_SHARED_SECRET;
const TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 2000);

// We only care about these for the email pipeline
const LIVE_KINDS = new Set([
  'system.stream.online',
  'system.stream.offline'
]);

export async function forwardEvent(kind, body) {
  const isLive = LIVE_KINDS.has(kind);

  // Ignore non-live events for this webhook
  if (!isLive) return;

  if (!url || !secret) {
    console.warn('[forward] LIVE event dropped – webhook misconfigured', {
      kind,
      hasUrl: !!url,
      hasSecret: !!secret,
    });
    return;
  }

  const json = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(json).digest('hex');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    console.log('[forward] LIVE event → sending', {
      kind,
      url,
      channel: body?.channel_slug || body?.channel?.slug || null,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraplet-Signature': sig,
      },
      body: json,
      signal: ctrl.signal,
    });

    const txt = await res.text().catch(() => '');

    if (!res.ok) {
      console.warn('[forward] LIVE', kind, res.status, txt.slice(0, 200));
    } else {
      console.log('[forward] LIVE event → OK', kind, res.status);
    }
  } catch (e) {
    console.error(
      '[forward] LIVE event → error',
      kind,
      e?.stack || e?.message || e
    );
  } finally {
    clearTimeout(t);
  }
}
