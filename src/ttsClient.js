// /src/ttsClient.js
export async function enqueueFreeTTS({
  scrapletUserId,
  channelSlug,
  text,
  platform = "kick",
  requestedByUsername = null,
}) {
  const base = process.env.DASHBOARD_INTERNAL_URL || "http://127.0.0.1:3000";
  const key = process.env.TTS_FREE_INTERNAL_KEY || "";

  const r = await fetch(`${base}/api/tts/free`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-scraplet-internal-key": key,
    },
    body: JSON.stringify({
      scrapletUserId,
      channelSlug,
      platform,
      text,
      requestedByUsername,
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`enqueueFreeTTS failed: ${r.status} ${body}`);
  }
}
