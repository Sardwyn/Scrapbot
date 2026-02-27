// /var/www/scrapbot/src/lib/metrics.js
// In-memory metrics + ring buffer for Scrapbot observability.
// No DB writes. No background worker. Deterministic.

function nowMs() {
  return Date.now();
}

class RingBuffer {
  constructor(capacity = 500) {
    this.capacity = Math.max(10, Number(capacity) || 500);
    this.arr = new Array(this.capacity);
    this.size = 0;
    this.idx = 0; // next insert position
  }

  push(item) {
    this.arr[this.idx] = item;
    this.idx = (this.idx + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  newestFirst(limit = 200) {
    const n = Math.max(1, Math.min(this.size, Number(limit) || 200));
    const out = [];
    for (let i = 0; i < n; i++) {
      const pos = (this.idx - 1 - i + this.capacity) % this.capacity;
      const v = this.arr[pos];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  oldestFirst(limit = 200) {
    const arr = this.newestFirst(limit);
    arr.reverse();
    return arr;
  }

  allNewestFirst() {
    return this.newestFirst(this.capacity);
  }
}

const bootMs = nowMs();

const counters = new Map(); // key -> number
const gauges = new Map(); // key -> { value, ts }
const pulseLatest = new Map(); // channelKey -> { pulse, tripwire, ts }
const ring = new RingBuffer(Number(process.env.SCRAPBOT_METRICS_RING_SIZE || 500) || 500);
const commandTraceRing = new RingBuffer(Number(process.env.SCRAPBOT_COMMAND_TRACE_SIZE || 100) || 100);

function inc(key, by = 1) {
  const k = String(key);
  const next = (counters.get(k) || 0) + (Number(by) || 1);
  counters.set(k, next);
  return next;
}

function setGauge(key, value) {
  gauges.set(String(key), { value, ts: nowMs() });
}

function chanKey(platform, channelSlug, scraplet_user_id) {
  return `${String(platform || "kick").toLowerCase()}|${String(channelSlug || "").toLowerCase()}|${Number(
    scraplet_user_id || 0
  )}`;
}

function safeStr(v) {
  if (v == null) return "";
  return String(v);
}

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

// Build “derived” views from the ring buffer (cheap: ring size is small)
function deriveFromRing({ limitChannels = 50, topTalkers = 12, topIncidentChannels = 12 } = {}) {
  const items = ring.allNewestFirst(); // newest -> oldest
  const byChannel = new Map(); // channelKey -> stats
  const talkers = new Map(); // talkerKey -> { ... }

  for (const it of items) {
    if (!it) continue;

    const key = chanKey(it.platform, it.channelSlug, it.scraplet_user_id);

    let ch = byChannel.get(key);
    if (!ch) {
      ch = {
        key,
        platform: it.platform || "kick",
        channelSlug: it.channelSlug || "",
        scraplet_user_id: Number(it.scraplet_user_id || 0) || 0,
        last_ts: 0,

        messages: 0,
        commands: 0,
        replies: 0,
        flood: 0,
        swarm: 0,
        moderation: 0,
        errors: 0,

        pulse_active_last: false,
      };
      byChannel.set(key, ch);
    }

    ch.messages += 1;
    ch.last_ts = Math.max(ch.last_ts || 0, Number(it.ts || 0) || 0);

    if (it.commandMatched) ch.commands += 1;
    if (it.commandReplySent) ch.replies += 1;
    if (it.flood) ch.flood += 1;
    if (it.swarm) ch.swarm += 1;
    if (it.moderation) ch.moderation += 1;
    if (it.error) ch.errors += 1;
    if (it.pulse_active) ch.pulse_active_last = true;

    // top talkers: per (tenant, channel, user)
    const userId = safeStr(it.senderUserId).trim();
    const username = safeStr(it.senderUsername).trim();
    const role = safeStr(it.userRole).trim() || "everyone";

    // Prefer userId key, fallback to username
    const talkerKey = `${key}|${userId || `u:${username.toLowerCase()}`}`;
    if (userId || username) {
      let t = talkers.get(talkerKey);
      if (!t) {
        t = {
          key: talkerKey,
          platform: it.platform || "kick",
          channelSlug: it.channelSlug || "",
          scraplet_user_id: Number(it.scraplet_user_id || 0) || 0,
          senderUserId: userId || null,
          senderUsername: username || null,
          userRole: role || "everyone",
          messages: 0,
          commands: 0,
          incidents: 0,
          last_ts: 0,
        };
        talkers.set(talkerKey, t);
      }

      t.messages += 1;
      t.last_ts = Math.max(t.last_ts || 0, Number(it.ts || 0) || 0);
      if (it.commandMatched) t.commands += 1;

      // “incidents” for talker: flood/swarm/mod/error flags
      const incident = !!(it.flood || it.swarm || it.moderation || it.error);
      if (incident) t.incidents += 1;
    }
  }

  // attach last pulse snapshot (if present) into derived per-channel stats
  for (const [k, v] of pulseLatest.entries()) {
    const ch = byChannel.get(k);
    if (!ch) continue;
    ch.pulse = v?.pulse || null;
    ch.tripwire = v?.tripwire || null;
    ch.pulse_active_last = !!v?.pulse?.active || ch.pulse_active_last;
  }

  // rank channels
  const channelsArr = Array.from(byChannel.values());
  channelsArr.sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  const channelsLimited = channelsArr.slice(0, clampInt(limitChannels, 1, 200, 50));

  // “incident channels” — weighted badness
  const incidentArr = Array.from(byChannel.values()).map((ch) => {
    const score =
      (ch.errors || 0) * 5 +
      (ch.moderation || 0) * 4 +
      (ch.swarm || 0) * 3 +
      (ch.flood || 0) * 2;
    return { ...ch, score };
  });
  incidentArr.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.last_ts || 0) - (a.last_ts || 0));
  const incidentLimited = incidentArr.slice(0, clampInt(topIncidentChannels, 1, 50, 12));

  // top talkers
  const talkersArr = Array.from(talkers.values());
  talkersArr.sort(
    (a, b) =>
      (b.messages || 0) - (a.messages || 0) ||
      (b.incidents || 0) - (a.incidents || 0) ||
      (b.last_ts || 0) - (a.last_ts || 0)
  );
  const talkersLimited = talkersArr.slice(0, clampInt(topTalkers, 1, 50, 12));

  // ring window bounds
  let windowNewestTs = 0;
  let windowOldestTs = 0;
  if (items.length) {
    windowNewestTs = Number(items[0]?.ts || 0) || 0;
    windowOldestTs = Number(items[items.length - 1]?.ts || 0) || 0;
  }

  return {
    ring_window: {
      capacity: ring.capacity,
      size: ring.size,
      newest_ts: windowNewestTs,
      oldest_ts: windowOldestTs,
    },
    channels: channelsLimited,
    top_talkers: talkersLimited,
    top_incident_channels: incidentLimited,
  };
}

export function metricsRecordInbound({
  platform,
  channelSlug,
  scraplet_user_id,
  userRole,
  senderUsername,
  senderUserId,
  eventType,
  message_id,
  pulse,
  tripwire,
  floodDecision,
  swarmDecision,
  moderationDecision,
  commandDecision,
  commandReplySent,
  error,
}) {
  const t = nowMs();
  const plat = String(platform || "kick").toLowerCase();
  const tenant = Number(scraplet_user_id || 0) || 0;
  const ch = String(channelSlug || "").toLowerCase();

  inc("inbound_total");
  inc(`inbound_total:${plat}`);
  if (tenant) inc(`inbound_total:${plat}:tenant:${tenant}`);
  if (tenant && ch) inc(`inbound_total:${plat}:tenant:${tenant}:channel:${ch}`);

  if (error) inc("inbound_errors_total");

  // Decisions
  if (floodDecision?.matched) inc("flood_tripped_total");
  if (swarmDecision?.matched) inc("swarm_matched_total");
  if (Array.isArray(swarmDecision?.actions) && swarmDecision.actions.length) inc("swarm_actions_total");
  if (moderationDecision?.matched) inc("moderation_matched_total");

  // Commands: allow multiple shapes
  const commandMatched =
    typeof commandDecision === "string"
      ? !!String(commandDecision).trim()
      : !!(commandDecision?.matched || commandDecision?.text || commandDecision?.response?.text);

  if (commandMatched) inc("commands_matched_total");
  if (commandReplySent) inc("commands_replies_sent_total");

  // Pulse snapshot per channel
  if (pulse) {
    const key = chanKey(plat, ch, tenant);
    pulseLatest.set(key, { pulse, tripwire, ts: t });

    setGauge(`pulse_active:${key}`, pulse.active ? 1 : 0);
    if (typeof pulse.short_rate_per_sec === "number") setGauge(`pulse_rate:${key}`, pulse.short_rate_per_sec);
    if (typeof pulse.unique_users_short === "number")
      setGauge(`pulse_unique_users_short:${key}`, pulse.unique_users_short);
  }

  // Ring buffer entry (keep small — no raw text)
  ring.push({
    ts: t,
    platform: plat,
    scraplet_user_id: tenant,
    channelSlug: ch,

    userRole: userRole || null,
    senderUsername: senderUsername || null,
    senderUserId: senderUserId != null ? String(senderUserId) : null,

    eventType: eventType || null,
    message_id: message_id || null,

    pulse_active: !!pulse?.active,
    pulse_rate: typeof pulse?.short_rate_per_sec === "number" ? pulse.short_rate_per_sec : null,
    pulse_unique_users: typeof pulse?.unique_users_short === "number" ? pulse.unique_users_short : null,

    tripwire: tripwire || null,

    flood: floodDecision?.matched ? { action: floodDecision.action, duration_seconds: floodDecision.duration_seconds } : null,
    swarm: swarmDecision?.matched ? { actions: (swarmDecision.actions || []).map((a) => a.action) } : null,
    moderation: moderationDecision?.matched
      ? { action: moderationDecision.action || moderationDecision?.decision?.action || null }
      : null,

    commandMatched,
    commandReplySent: !!commandReplySent,

    error: error ? String(error) : null,
  });
}

export function metricsSnapshot({ limitChannels = 50, topTalkers = 12, topIncidentChannels = 12 } = {}) {
  const uptimeMs = nowMs() - bootMs;

  const counterObj = {};
  for (const [k, v] of counters.entries()) counterObj[k] = v;

  const gaugeObj = {};
  for (const [k, v] of gauges.entries()) gaugeObj[k] = v;

  const pulses = [];
  for (const [k, v] of pulseLatest.entries()) pulses.push({ key: k, ...v });
  pulses.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const limitedPulses = pulses.slice(0, Math.max(1, Number(limitChannels) || 50));

  const derived = deriveFromRing({
    limitChannels,
    topTalkers,
    topIncidentChannels,
  });

  return {
    ok: true,
    service: "scrapbot",
    now: new Date().toISOString(),
    uptime_ms: uptimeMs,

    counters: counterObj,
    gauges: gaugeObj,

    pulse_latest: limitedPulses,

    // ring meta
    ring: { capacity: ring.capacity, size: ring.size },

    // NEW: derived visibility
    derived,
  };
}

export function metricsRecent({ limit = 200, order = "newest" } = {}) {
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  const ord = String(order || "newest").toLowerCase();
  const items = ord === "oldest" ? ring.oldestFirst(n) : ring.newestFirst(n);

  return {
    ok: true,
    service: "scrapbot",
    now: new Date().toISOString(),
    order: ord,
    items,
  };
}

// -------------------------------------------------------------------
// Audit ring buffer — detailed moderation decision records
// -------------------------------------------------------------------
const auditRing = new RingBuffer(
  Number(process.env.SCRAPBOT_AUDIT_RING_SIZE || 100) || 100
);

export function metricsRecordAudit({
  test_run_id = null,
  event_id = null,
  message_id = null,
  channelSlug = null,
  senderUsername = null,
  senderUserId = null,
  userRole = null,
  text_preview = null,
  floodDecision = null,
  swarmDecision = null,
  moderationDecision = null,
  commandDecision = null,
  trustDecision = null,
  actions_attempted = [],
  actions_results = [],
} = {}) {
  auditRing.push({
    ts: nowMs(),
    test_run_id: test_run_id || null,
    event_id: event_id || null,
    message_id: message_id || null,
    channelSlug: channelSlug || null,
    senderUsername: senderUsername || null,
    senderUserId: senderUserId != null ? String(senderUserId) : null,
    userRole: userRole || null,
    text_preview: String(text_preview || "").slice(0, 120),
    flood: floodDecision || null,
    swarm: swarmDecision || null,
    moderation: moderationDecision || null,
    command: commandDecision || null,
    trust: trustDecision || null,
    actions_attempted: actions_attempted || [],
    actions_results: actions_results || [],
  });
}

export function metricsAuditRecent({ limit = 50, channelSlug = null } = {}) {
  let items = auditRing.newestFirst(200);
  if (channelSlug) {
    const slug = String(channelSlug).toLowerCase().trim();
    items = items.filter(it => it && String(it.channelSlug || "").toLowerCase().trim() === slug);
  }
  return {
    ok: true,
    service: "scrapbot",
    now: new Date().toISOString(),
    items: items.slice(0, Math.min(Math.max(1, Number(limit) || 50), 200)),
  };
}

// -------------------------------------------------------------------
// Command Trace ring buffer — detailed command execution records
// -------------------------------------------------------------------
export function metricsRecordCommandTrace(trace) {
  commandTraceRing.push({
    ts: nowMs(),
    ...trace
  });
}

export function metricsGetRecentCommandTraces({ limit = 20 } = {}) {
  return {
    ok: true,
    service: "scrapbot",
    now: new Date().toISOString(),
    items: commandTraceRing.newestFirst(Math.min(Math.max(1, Number(limit) || 20), 100)),
  };
}
