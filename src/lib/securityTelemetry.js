// /var/www/scrapbot/src/lib/securityTelemetry.js
import crypto from "crypto";

const MAX_EVENTS = 5000;
const events = []; // newest-first probe events (security.probe)

const rateCounters = new Map(); // key -> { count, windowStartMs } (used for rateLimitHit)
const lastLog = new Map();      // ip -> lastLogMs (for log throttling)

// Rolling counters (1m/5m) using per-second buckets
const WINDOW_5M_SEC = 300;
const buckets = Array.from({ length: WINDOW_5M_SEC }, () => ({
  tsSec: 0,
  req: 0,
  probes: 0,
  blocked: 0,
  s2xx: 0,
  s3xx: 0,
  s4xx: 0,
  s5xx: 0,
}));

function nowMs() {
  return Date.now();
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function bucketFor(tsSec) {
  const idx = tsSec % WINDOW_5M_SEC;
  const b = buckets[idx];
  if (b.tsSec !== tsSec) {
    b.tsSec = tsSec;
    b.req = 0;
    b.probes = 0;
    b.blocked = 0;
    b.s2xx = 0;
    b.s3xx = 0;
    b.s4xx = 0;
    b.s5xx = 0;
  }
  return b;
}

function bumpStatus(tsSec, statusCode) {
  const b = bucketFor(tsSec);
  const s = Number(statusCode) || 0;
  if (s >= 200 && s < 300) b.s2xx += 1;
  else if (s >= 300 && s < 400) b.s3xx += 1;
  else if (s >= 400 && s < 500) b.s4xx += 1;
  else if (s >= 500) b.s5xx += 1;
}

function rollup(lastNSec) {
  const now = nowSec();
  const cutoff = now - lastNSec + 1;
  const out = {
    req: 0,
    probes: 0,
    blocked: 0,
    s2xx: 0,
    s3xx: 0,
    s4xx: 0,
    s5xx: 0,
  };

  for (const b of buckets) {
    if (b.tsSec >= cutoff && b.tsSec <= now) {
      out.req += b.req;
      out.probes += b.probes;
      out.blocked += b.blocked;
      out.s2xx += b.s2xx;
      out.s3xx += b.s3xx;
      out.s4xx += b.s4xx;
      out.s5xx += b.s5xx;
    }
  }
  return out;
}

function pushEvent(ev) {
  events.unshift(ev);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

function getIp(req) {
  // You’re behind nginx, so XFF is the real world; fall back to socket.
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function classify(req) {
  const method = (req.method || "").toUpperCase();
  const path = req.path || req.originalUrl || "";
  const q = req.url || "";
  const ua = String(req.headers["user-agent"] || "").toLowerCase();

  const suspiciousMethods = new Set(["PROPFIND", "TRACE", "CONNECT"]);
  const badPathPrefixes = [
    "/.env",
    "/.git",
    "/wp-",
    "/phpmyadmin",
    "/cgi-bin",
    "/vendor",
    "/actuator",
    "/_bk",
    "/admin",
  ];

  const badQueryNeedles = ["cmd=", "exec", "wget", "curl", "bash", "sh", "powershell", "nc "];

  const looksProbe =
    suspiciousMethods.has(method) ||
    badPathPrefixes.some((p) => path.startsWith(p)) ||
    badQueryNeedles.some((n) => q.toLowerCase().includes(n)) ||
    ua === "" ||
    ua.includes("zgrab") ||
    ua.includes("masscan") ||
    ua.includes("sqlmap") ||
    ua.includes("nikto");

  return {
    looksProbe,
    category: looksProbe ? "probe" : "normal",
    confidence: looksProbe ? "high" : "low",
  };
}

// ---- Existing rate limiter (keep) ----
function rateLimitKey(ip, category) {
  return `${ip}:${category}`;
}

function rateLimitHit(ip, category, { limit = 20, windowMs = 60_000 } = {}) {
  const key = rateLimitKey(ip, category);
  const t = nowMs();

  let entry = rateCounters.get(key);
  if (!entry || t - entry.windowStartMs > windowMs) {
    entry = { count: 0, windowStartMs: t };
    rateCounters.set(key, entry);
  }

  entry.count += 1;
  return entry.count > limit;
}

function shouldLogProbe(ip, { minIntervalMs = 10_000 } = {}) {
  const t = nowMs();
  const last = lastLog.get(ip) || 0;
  if (t - last >= minIntervalMs) {
    lastLog.set(ip, t);
    return true;
  }
  return false;
}

function parseIsoTsToMs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

function topFromProbeEvents({ windowMs = 5 * 60_000, topN = 10 } = {}) {
  const cutoff = nowMs() - windowMs;

  const paths = new Map();
  const ips = new Map();
  const uas = new Map();

  for (const ev of events) {
    const t = parseIsoTsToMs(ev.ts);
    if (!t || t < cutoff) break; // events are newest-first

    const p = String(ev.path || "");
    const ip = String(ev.ip || "");
    const ua = String(ev.ua || "");

    if (p) paths.set(p, (paths.get(p) || 0) + 1);
    if (ip) ips.set(ip, (ips.get(ip) || 0) + 1);
    if (ua) uas.set(ua, (uas.get(ua) || 0) + 1);
  }

  function toTop(map) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([key, count]) => ({ key, count }));
  }

  return {
    top_paths: toTop(paths),
    top_ips: toTop(ips),
    top_uas: toTop(uas),
  };
}

// -----------------------------
// Middleware
// -----------------------------
export function securityTelemetryMiddleware(req, res, next) {
  const tsSec = nowSec();
  bucketFor(tsSec).req += 1;

  // Capture status buckets for ALL requests (not just probes)
  res.on("finish", () => {
    bumpStatus(tsSec, res.statusCode);
    if (res.statusCode === 429) {
      bucketFor(tsSec).blocked += 1;
    }
  });

  const ip = getIp(req);
  const { looksProbe, category, confidence } = classify(req);

  if (!looksProbe) return next();

  // Probe-specific counters
  bucketFor(tsSec).probes += 1;

  const method = (req.method || "").toUpperCase();
  const path = req.path || req.originalUrl || "";
  const ua = String(req.headers["user-agent"] || "");
  const host = String(req.headers.host || "");
  const ref = String(req.headers.referer || "");

  const reqId = crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");
  const ev = {
    ts: new Date().toISOString(),
    type: "security.probe",
    reqId,
    ip,
    method,
    path,
    host,
    ua,
    ref,
    confidence,
  };

  pushEvent(ev);

  // Log throttling: you still see it, just not 500 lines/sec.
  if (shouldLogProbe(ip)) {
    console.log("[SECURITY]", JSON.stringify(ev));
  }

  // Rate-limit probe-class requests (response can still be 404, but throttled).
  const limited = rateLimitHit(ip, category, { limit: 60, windowMs: 60_000 });
  if (limited) {
    return res.status(429).json({ ok: false, error: "Too Many Requests" });
  }

  return next();
}

// -----------------------------
// Exports for UI / ops
// -----------------------------
export function securityTelemetryRecent({ limit = 200 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
  return {
    ok: true,
    now: new Date().toISOString(),
    items: events.slice(0, n),
    counts: { buffered: events.length },
  };
}

export function securityTelemetrySnapshot({ topN = 10 } = {}) {
  const last1m = rollup(60);
  const last5m = rollup(300);

  const top = topFromProbeEvents({ windowMs: 5 * 60_000, topN });

  return {
    ok: true,
    now: new Date().toISOString(),
    rolling: {
      last_1m: last1m,
      last_5m: last5m,
    },
    top_5m: top,
    buffer: {
      probe_events_buffered: events.length,
      max_probe_events: MAX_EVENTS,
    },
  };
}
