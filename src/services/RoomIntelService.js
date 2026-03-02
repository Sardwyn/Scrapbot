// src/services/RoomIntelService.js
//
// Unified Room Intelligence Service (v1.6)
// Provides real-time chat telemetry (MPM, EI, State) across all platforms.
//

import roomIntelStore from "../stores/roomIntelStore.js";

const ROOMINTEL_ENABLED = String(process.env.ROOMINTEL_ENABLED || "1") !== "0";
const ROOMINTEL_BUCKET_MS = 5_000;

// In-memory bucket accumulator per channel
// key = `${scraplet_user_id}|${platform}|${channel_slug}`
const roomIntelBuckets = new Map();

function roomIntelKey({ scraplet_user_id, platform, channel_slug }) {
    return `${Number(scraplet_user_id)}|${String(platform)}|${String(channel_slug)}`;
}

/**
 * VERY lightweight register classifier (v1.5).
 * Goal: good-enough signal without risking moderation correctness.
 * Registers:
 *  r1 = Passive / low intent
 *  r2 = Casual / banter
 *  r3 = Engaged / conversational
 *  r4 = Focused / high intent (questions, instructions)
 *  r5 = Hyped / emoji/emote-only / excitement
 */
function classifyRegister({ text, emoji_only, emote_only }) {
    const t = String(text || "").trim();
    if (!t) return 1;

    if (emoji_only || emote_only) return 5;

    const lower = t.toLowerCase();

    // "Focused" / instructive / investigative
    if (
        lower.includes("how do i") ||
        lower.includes("how to ") ||
        lower.includes("can you") ||
        lower.includes("could you") ||
        lower.includes("help me") ||
        lower.includes("why ") ||
        lower.includes("what is") ||
        lower.includes("what's") ||
        lower.includes("where ") ||
        lower.includes("when ")
    )
        return 4;

    if (t.includes("?")) return 3;

    // Casual banter markers
    if (/\b(lol|lmao|rofl|haha|hehe|omg|wtf)\b/i.test(lower)) return 2;

    return 1;
}

function roomStateFromEI(ei) {
    const x = Number(ei || 0);
    if (x >= 80) return "Hyped";
    if (x >= 60) return "Focused";
    if (x >= 40) return "Engaged";
    if (x >= 20) return "Casual";
    return "Passive";
}

function pressureFromTripwire(tripwire) {
    const t = String(tripwire || "").toLowerCase();
    if (!t) return null;
    if (t.includes("hot") || t.includes("red")) return 85;
    if (t.includes("warm") || t.includes("yellow")) return 55;
    if (t.includes("cool") || t.includes("green")) return 25;
    return 40; // unknown-but-present
}

function flushRoomIntelBucket(key, b) {
    try {
        if (!b) return;

        const total = b.messages || 0;
        if (total <= 0) return;

        const w = b.r1 * 0.0 + b.r2 * 0.25 + b.r3 * 0.5 + b.r4 * 0.75 + b.r5 * 1.0;

        const ei = Math.max(0, Math.min(100, Math.round((w / Math.max(1, total)) * 100)));

        const snapshot = {
            scraplet_user_id: b.scraplet_user_id,
            platform: b.platform,
            channel_slug: b.channel_slug,
            bucket_ts: new Date(b.bucketStartMs),
            engagement_index: ei,
            room_state: roomStateFromEI(ei),

            // proportions 0..1
            r1: total ? b.r1 / total : 0,
            r2: total ? b.r2 / total : 0,
            r3: total ? b.r3 / total : 0,
            r4: total ? b.r4 / total : 0,
            r5: total ? b.r5 / total : 0,

            messages: total,
            mpm: Math.round((total * 60_000) / ROOMINTEL_BUCKET_MS), // approx messages per minute
            pressure: b.pressure ?? null,
            meta: {
                tripwire: b.tripwire ?? null,
            },
        };

        // Fire-and-forget; store is already try/catch defensive.
        roomIntelStore.insertSnapshot(snapshot);
    } catch (e) {
        console.warn("[RoomIntelService] flush failed", e?.message || e);
    }
}

/**
 * Ingests a normalized event into the Room Intel pipeline.
 */
export function observe(event) {
    if (!ROOMINTEL_ENABLED) return;

    // Only observe real chat text; ignore privileged chatter to reduce creator self-noise.
    const isPrivileged = event.userRole === "broadcaster" || event.userRole === "mod";
    if (isPrivileged) return;

    const now = Date.now();
    const bucketStartMs = Math.floor(now / ROOMINTEL_BUCKET_MS) * ROOMINTEL_BUCKET_MS;

    const key = roomIntelKey({
        scraplet_user_id: event.scraplet_user_id,
        platform: event.platform,
        channel_slug: event.channelSlug,
    });

    let b = roomIntelBuckets.get(key);
    if (!b || b.bucketStartMs !== bucketStartMs) {
        // flush previous
        if (b) flushRoomIntelBucket(key, b);

        b = {
            scraplet_user_id: event.scraplet_user_id,
            platform: event.platform,
            channel_slug: event.channelSlug,
            bucketStartMs,
            messages: 0,
            r1: 0,
            r2: 0,
            r3: 0,
            r4: 0,
            r5: 0,
            tripwire: event.__tripwire ?? null,
            pressure: pressureFromTripwire(event.__tripwire),
        };

        roomIntelBuckets.set(key, b);
    }

    // keep latest tripwire/pressure (read-only hint)
    b.tripwire = event.__tripwire ?? b.tripwire;
    b.pressure = pressureFromTripwire(b.tripwire);

    const reg = classifyRegister({
        text: event.text,
        emoji_only: !!event?.meta?.emoji_only,
        emote_only: !!event?.meta?.emote_only,
    });

    b.messages += 1;
    if (reg === 1) b.r1 += 1;
    else if (reg === 2) b.r2 += 1;
    else if (reg === 3) b.r3 += 1;
    else if (reg === 4) b.r4 += 1;
    else b.r5 += 1; // default to r5 if anything odd
}

export default {
    observe,
};
