// src/lib/sendEventToDashboard.js
import crypto from "crypto";
import { createEnvelope } from "./envelope.js";

const DASHBOARD_URL =
  process.env.DASHBOARD_EVENT_URL || "https://scraplet.store/api/kick-ingest";

const SHARED_SECRET = (process.env.SCRAPLET_SHARED_SECRET || "").trim();

export async function sendEventToDashboard({
  platform = "kick",
  type,
  kind = null,
  owner_user_id = null,
  channel = {},
  actor = {},
  payload = {},
  raw = null,
  meta = {},
}) {
  try {
    const envelope = createEnvelope({
      platform,
      type,
      kind,
      owner_user_id,
      channel,
      actor,
      payload,
      raw,
      meta,
    });

    const body = JSON.stringify(envelope);

    if (!SHARED_SECRET) {
      console.error("[Scrapbot] SCRAPLET_SHARED_SECRET missing; refusing to send event");
      return false;
    }

    const sig = crypto.createHmac("sha256", SHARED_SECRET).update(body).digest("hex");

    const res = await fetch(DASHBOARD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Scraplet-Signature": sig,
      },
      body,
    });

    if (!res.ok) {
      console.error(
        `[Scrapbot] Dashboard ingest failed: ${res.status}`,
        (await res.text().catch(() => "")).slice(0, 400)
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error("[Scrapbot] Error forwarding event to dashboard:", err);
    return false;
  }
}
