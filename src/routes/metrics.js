// /var/www/scrapbot/src/routes/metrics.js
import express from "express";
import crypto from "crypto";
import { metricsSnapshot, metricsRecent, metricsAuditRecent, metricsRecordCommandTrace, metricsGetRecentCommandTraces } from "../lib/metrics.js";
import { securityTelemetrySnapshot } from "../lib/securityTelemetry.js";
import { listTestCases, getTestCaseById } from "../moderation/moderationTestCases.js";
import { runPipelineDry, evaluateAssertions } from "../moderation/testRunner.js";
import { listCommandTestCases, getCommandTestCaseById } from "../moderation/commandTestCases.js";
import { evaluateChatCommand } from "../commandRuntime.js";
import { renderMetricsHtml } from "../views/metricsView.js";

console.log("[metricsRoutes] module loaded");

const router = express.Router();

function requireSecret(req, res) {
  const expected = process.env.SCRAPBOT_SHARED_SECRET;
  if (!expected) return true;

  const provided = req.headers["x-scrapbot-secret"];
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ─── Existing endpoints ──────────────────────────────────

router.get("/metrics", (req, res) => {
  const secret = req.query.secret || "";
  // If no secret in query, it might fail internal requireSecret calls in fetch, 
  // but for the UI load we just embed what we have.
  res.header("Content-Type", "text/html");
  return res.send(renderMetricsHtml({ secret: secret || process.env.SCRAPBOT_SHARED_SECRET || "" }));
});

router.get("/api/metrics", (req, res) => {
  console.log("[metricsRoutes] HIT /api/metrics");
  if (!requireSecret(req, res)) return;
  const limitChannels = Number(req.query.limitChannels || 50) || 50;
  return res.json(metricsSnapshot({ limitChannels }));
});

router.get("/api/metrics/recent", (req, res) => {
  console.log("[metricsRoutes] HIT /api/metrics/recent");
  if (!requireSecret(req, res)) return;
  const limit = Number(req.query.limit || 200) || 200;
  const order = String(req.query.order || "newest");
  return res.json(metricsRecent({ limit, order }));
});

router.get("/security", (req, res) => {
  const topN = req.query.topN ? Number(req.query.topN) : 10;
  return res.json(securityTelemetrySnapshot({ topN }));
});

// ─── Audit endpoint ──────────────────────────────────────

router.get("/api/metrics/audit", (req, res) => {
  if (!requireSecret(req, res)) return;
  const limit = Number(req.query.limit || 50) || 50;
  const channelSlug = req.query.channelSlug || null;
  return res.json(metricsAuditRecent({ limit, channelSlug }));
});

// ─── Test runner endpoints ───────────────────────────────

router.get("/api/metrics/tests", (req, res) => {
  if (!requireSecret(req, res)) return;
  return res.json({ ok: true, tests: listTestCases() });
});

router.post("/api/metrics/tests/run", express.json(), async (req, res) => {
  if (!requireSecret(req, res)) return;

  try {
    const { test_id, channelSlug, scraplet_user_id, broadcasterUserId } = req.body || {};

    if (!test_id) {
      return res.status(400).json({ ok: false, error: "missing test_id" });
    }

    const testCase = getTestCaseById(test_id);
    if (!testCase) {
      return res.status(404).json({ ok: false, error: `test not found: ${test_id}` });
    }

    const test_run_id = crypto.randomUUID();

    const overrides = {};
    if (channelSlug) overrides.channelSlug = channelSlug;
    if (scraplet_user_id) overrides.scraplet_user_id = scraplet_user_id;
    if (broadcasterUserId) overrides.broadcasterUserId = broadcasterUserId;

    const pipelineResult = await runPipelineDry(testCase, overrides, test_run_id);

    // Evaluate assertions
    const assertionResults = evaluateAssertions(pipelineResult, testCase.assert || []);
    const allPassed = assertionResults.every((a) => a.pass);

    return res.json({
      ok: true,
      test_run_id,
      test_id: testCase.id,
      test_name: testCase.name,
      category: testCase.category,
      passed: allPassed,
      assertions: assertionResults,
      pipeline: pipelineResult,
    });
  } catch (err) {
    console.error("[metricsRoutes] test run error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ─── Command Test Lab ────────────────────────────────────

router.get("/api/metrics/tests/commands", (req, res) => {
  if (!requireSecret(req, res)) return;
  return res.json({ ok: true, tests: listCommandTestCases() });
});

router.post("/api/metrics/tests/commands/run", express.json(), async (req, res) => {
  if (!requireSecret(req, res)) return;

  try {
    const { test_id, messageText, userRole, userName, channelSlug, broadcasterUserId } = req.body || {};
    let testCase = test_id ? getCommandTestCaseById(test_id) : null;

    // Build raw input from either testCase or manual input
    const input = {
      messageText: messageText || testCase?.setup?.messageText || "!help",
      userRole: userRole || testCase?.setup?.userRole || "everyone",
      userName: userName || testCase?.setup?.userName || "test_user",
      channelSlug: channelSlug || testCase?.setup?.channelSlug || "testchannel",
      broadcasterUserId: broadcasterUserId || "1017792",
    };

    const test_run_id = crypto.randomUUID();

    // 1. Evaluate Command (Dry Run)
    // We pass dryRun: true to any actions dispatched
    const commandResult = await evaluateChatCommand({
      platform: "kick",
      channelSlug: input.channelSlug,
      userName: input.userName,
      userRole: input.userRole,
      messageText: input.messageText,
      dryRun: true // Enforce dry-run behavior
    });

    // 2. Build Actions Results (Hypothetical)
    const actions_results = (commandResult?.actions || []).map(a => ({
      ...a,
      dryRun: true,
      status: "WOULD_SEND"
    }));

    const trace = {
      test_run_id,
      input,
      command: {
        ...(commandResult || { matched: false }),
        args: commandResult?.args || []
      },
      actions_results
    };

    // 3. Optional: Run assertions if it was a pre-defined test
    let assertionResults = [];
    let passed = true;
    if (testCase) {
      assertionResults = evaluateAssertions({ last: trace }, testCase.assert || []);
      passed = assertionResults.every(a => a.pass);
    }

    // Record trace for the UI
    metricsRecordCommandTrace(trace);

    return res.json({
      ok: true,
      passed,
      trace,
      assertions: assertionResults
    });
  } catch (err) {
    console.error("[metricsRoutes] command test run error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.get("/api/metrics/tests/commands/traces", (req, res) => {
  if (!requireSecret(req, res)) return;
  const limit = Number(req.query.limit || 20) || 20;
  return res.json(metricsGetRecentCommandTraces({ limit }));
});

// (HTML frontend removed — Test Lab UI now lives in scraplet-dashboard/views/dashboard-metrics.ejs)

export default router;
