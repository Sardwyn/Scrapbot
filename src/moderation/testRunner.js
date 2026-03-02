// src/moderation/testRunner.js
// Dry-run pipeline runner for the Moderation Test Lab.
// Mirrors inboundKick's moderation pipeline order but NEVER calls
// executeModerationAction, executeSwarmActions, or sendKickChatMessage.
//
// All decisions are evaluated but actions are reported as { dryRun: true, would: {...} }.

import { evaluateModeration } from "../moderationRuntime.js";
import { evaluateSwarm } from "./swarmGuard.js";
import { decisionToActionPayload } from "../moderationActions.js";
import { getModerationRulesFor } from "../moderationStore.js";
import { metricsRecordAudit } from "../lib/metrics.js";

// FloodGuard — import module and probe for function
import * as floodGuard from "../lib/floodGuard.js";

// Trust — import read-only precheck; we call it but never act on it
import { shouldAutoHostileAction } from "../stores/trustStore.js";

// Command evaluation (read-only)
import { evaluateChatCommand } from "../commandRuntime.js";

// ─── Helpers ───────────────────────────────────────────

function safeStr(v) {
    if (v == null) return "";
    return String(v);
}

function resolveUserRole({ senderUserId, broadcasterUserId, badges, userRole }) {
    // If explicitly set, use it
    if (userRole === "broadcaster") return "broadcaster";
    if (userRole === "mod" || userRole === "moderator") return "moderator";

    // Broadcaster check
    if (
        senderUserId != null &&
        broadcasterUserId != null &&
        String(senderUserId) === String(broadcasterUserId)
    ) {
        return "broadcaster";
    }

    // Badge check
    const b = badges;
    const badgeText = Array.isArray(b) ? b.map((x) => safeStr(x).toLowerCase()) : [];
    if (
        badgeText.includes("moderator") ||
        badgeText.includes("mod")
    ) {
        return "moderator";
    }

    return "everyone";
}

async function checkFloodSafe(event) {
    try {
        if (event && event.meta && event.meta.emoji_only === true) return null;
        if (typeof floodGuard.checkFloodGuard === "function") {
            return await floodGuard.checkFloodGuard(event, {});
        }
        if (typeof floodGuard.evaluateFloodGuard === "function") {
            return await floodGuard.evaluateFloodGuard({
                platform: event.platform,
                scraplet_user_id: event.scraplet_user_id,
                channelSlug: event.channelSlug,
                senderUsername: event.senderUsername,
                senderUserId: event.senderUserId,
                userRole: event.userRole,
                text: event.text,
                __tripwire: event.__tripwire || null,
            });
        }
    } catch (e) {
        return { matched: false, error: e?.message || String(e) };
    }
    return null;
}

async function checkTrustSafe(event) {
    try {
        const isPrivileged = event.userRole === "broadcaster" || event.userRole === "moderator";
        if (isPrivileged) return { ok: true, hostile: false, skipped: "privileged" };

        const hostile = await shouldAutoHostileAction({
            platform: "kick",
            channel_id: event.channelSlug,
            user_id: String(event.senderUserId),
        });

        return hostile || { ok: true, hostile: false };
    } catch (e) {
        return { ok: false, hostile: false, error: e?.message || String(e) };
    }
}

async function checkSwarmSafe(event) {
    try {
        const isPrivileged = event.userRole === "broadcaster" || event.userRole === "moderator";
        if (isPrivileged) return { matched: false, actions: [], skipped: "privileged" };

        return await evaluateSwarm(event);
    } catch (e) {
        return { matched: false, actions: [], error: e?.message || String(e) };
    }
}

async function checkModerationSafe(event, injectedRules) {
    try {
        // If test provides injected rules, use a patched evaluateModeration
        // that uses the injected rules instead of the DB-loaded ones.
        if (injectedRules && injectedRules.length > 0) {
            return await evaluateModerationWithRules(event, injectedRules);
        }

        return await evaluateModeration({
            platform: event.platform,
            scraplet_user_id: event.scraplet_user_id,
            channelSlug: event.channelSlug,
            text: event.text,
            senderUsername: event.senderUsername,
            userRole: event.userRole,
            meta: {
                senderUserId: event.senderUserId,
                broadcasterUserId: event.broadcasterUserId,
                message_id: event.message_id,
            },
        });
    } catch (e) {
        return { matched: false, error: e?.message || String(e) };
    }
}

/**
 * Inline rule evaluation for injected rules.
 * Mirrors moderationRuntime.evaluateModeration but uses provided rules instead of DB.
 */
function stripEmoji(text) {
    const s = String(text || "");
    try {
        return s
            .replace(/\p{Extended_Pictographic}/gu, "")
            .replace(/[\uFE0F\u200D]/g, "")
            .trim();
    } catch {
        return s.trim();
    }
}

function isEmojiOnly(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (/[a-z0-9]/i.test(raw)) return false;
    const noEmoji = stripEmoji(raw);
    if (!noEmoji) return true;
    try {
        const meaningful = noEmoji.replace(/[\s\p{P}\p{S}]/gu, "");
        return meaningful.length === 0;
    } catch {
        return !/[a-z0-9]/i.test(noEmoji);
    }
}

async function evaluateModerationWithRules(event, rules) {
    const role = (event.userRole || "everyone").toLowerCase();
    if (role === "broadcaster") return null;
    if (role === "mod" || role === "moderator") return null;

    const msgRaw = String(event.text || "").trim();
    if (!msgRaw) return null;
    if (isEmojiOnly(msgRaw)) return null;

    const msg = stripEmoji(msgRaw);
    if (!msg) return null;
    const lower = msg.toLowerCase();

    for (const rule of rules) {
        if (!rule || rule.enabled === false) continue;
        const ruleType = String(rule.rule_type || "").toLowerCase().trim();
        const ruleValue = String(rule.rule_value || "").trim();
        if (!ruleType || !ruleValue) continue;

        const ruleValueStripped = stripEmoji(ruleValue);
        if (!ruleValueStripped) continue;
        const valueLower = ruleValueStripped.toLowerCase();

        let matched = false;
        let match_reason = "";

        if (ruleType === "contains") {
            matched = lower.includes(valueLower);
            if (matched) match_reason = `Message contains "${ruleValueStripped}"`;
        } else if (ruleType === "equals") {
            matched = lower === valueLower;
            if (matched) match_reason = `Message exactly equals "${ruleValueStripped}"`;
        } else if (ruleType === "blacklist_word") {
            const escaped = valueLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu");
            matched = re.test(msg);
            if (matched) match_reason = `Message contains blacklisted word "${ruleValueStripped}"`;
        } else if (ruleType === "regex") {
            try {
                const re = new RegExp(ruleValue, "i");
                matched = re.test(msg);
                if (matched) match_reason = `Message matched regex /${ruleValue}/i`;
            } catch {
                matched = false;
            }
        } else if (ruleType === "caps_ratio") {
            const threshold = Number(ruleValueStripped);
            if (Number.isFinite(threshold) && msg.length >= 6) {
                const letters = msg.replace(/[^a-zA-Z]/g, "");
                if (letters.length >= 6) {
                    const upper = (letters.match(/[A-Z]/g) || []).length;
                    const ratio = upper / letters.length;
                    matched = ratio >= threshold;
                    if (matched) match_reason = `Caps ratio ${ratio.toFixed(2)} ≥ ${threshold}`;
                }
            }
        } else if (ruleType === "link_posting") {
            matched = /(https?:\/\/|www\.)\S+/i.test(msg);
            if (matched) match_reason = "Message contains a link";
        }

        if (!matched) continue;

        const action = String(rule.action || "none").toLowerCase();
        let duration_seconds = Number(rule.duration_seconds || 0) || 0;
        if (action === "ban" || action === "none") duration_seconds = 0;
        else if (action === "timeout") {
            if (!Number.isFinite(duration_seconds) || duration_seconds <= 0) duration_seconds = 30;
        }

        return {
            matched: true,
            platform: event.platform,
            scraplet_user_id: event.scraplet_user_id,
            channelSlug: event.channelSlug || null,
            senderUsername: event.senderUsername || "unknown",
            userRole: role,
            action,
            duration_seconds,
            rule: { id: rule.id, rule_type: rule.rule_type, rule_value: rule.rule_value },
            explain: { match_reason, normalized_action: action, normalized_duration_seconds: duration_seconds },
        };
    }

    return null;
}

async function checkCommandSafe(event) {
    try {
        return await evaluateChatCommand({
            platform: event.platform || "kick",
            channelSlug: event.channelSlug,
            userName: event.senderUsername,
            userRole: event.userRole,
            messageText: event.text,
        });
    } catch (e) {
        return { matched: false, error: e?.message || String(e) };
    }
}

// ─── Main Pipeline Runner ──────────────────────────────

/**
 * Run the full moderation pipeline in dry-run mode.
 * Returns a structured result with all decisions and hypothetical actions.
 *
 * @param {Object} testCase - The test case definition from moderationTestCases.js
 * @param {Object} overrides - Runtime overrides (channelSlug, scraplet_user_id, etc.)
 * @param {string} test_run_id - UUID for correlating audit entries
 * @returns {Object} Pipeline result with decisions and hypothetical actions
 */
export async function runPipelineDry(testCase, overrides = {}, test_run_id = null) {
    const events = testCase.setup?.events || [];
    if (!events.length) {
        return { ok: false, error: "No events in test case", test_run_id };
    }

    const injectedRules = testCase.setup?.injectedRules || [];
    const results = [];

    // Process each event in order (important for multi-event tests like flood)
    let lastResult = null;
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];

        const channelSlug = overrides.channelSlug || ev.channelSlug || "testchannel";
        const scraplet_user_id = overrides.scraplet_user_id || ev.scraplet_user_id || 1;
        const broadcasterUserId = overrides.broadcasterUserId || ev.broadcasterUserId || "1017792";

        const userRole = resolveUserRole({
            senderUserId: ev.senderUserId,
            broadcasterUserId,
            badges: ev.badges || [],
            userRole: ev.userRole,
        });

        const event = {
            platform: "kick",
            scraplet_user_id: Number(scraplet_user_id),
            channelSlug: channelSlug.toLowerCase().trim(),
            broadcasterUserId,
            senderUsername: ev.senderUsername || "test_user",
            senderUserId: ev.senderUserId || "99999",
            userRole,
            text: ev.text || "",
            message_id: `test-${test_run_id || "run"}-${i}`,
            __tripwire: null,
            meta: ev.meta || null,
        };

        const skipGuards = userRole === "broadcaster" || userRole === "moderator";

        // ── Trust precheck ──
        const trustDecision = !skipGuards
            ? await checkTrustSafe(event)
            : { ok: true, hostile: false, skipped: "privileged" };

        // ── Flood guard ──
        const floodDecision = !skipGuards
            ? await checkFloodSafe(event)
            : { matched: false, skipped: "privileged" };

        // ── Swarm guard ──
        const swarmDecision = await checkSwarmSafe(event);

        // ── Moderation rules ──
        const moderationDecision = await checkModerationSafe(event, injectedRules);

        // ── Commands ──
        const commandDecision = await checkCommandSafe(event);

        // ── Build hypothetical actions ──
        const actions_attempted = [];
        const actions_results = [];

        if (trustDecision?.hostile) {
            const action = safeStr(trustDecision.action || "").toLowerCase() || "timeout";
            actions_attempted.push("trust_hostile");
            actions_results.push({
                dryRun: true,
                label: "trust_hostile",
                would: {
                    action: action === "ban" ? "ban" : "timeout",
                    duration_seconds: Number(trustDecision.duration_seconds || 0) || 0,
                    reason: safeStr(trustDecision.reason || "trust_auto_hostile"),
                    target: event.senderUsername,
                },
            });
        }

        if (floodDecision?.matched) {
            const floodAction =
                String(floodDecision.action || "timeout").toLowerCase() === "ban"
                    ? "timeout"
                    : String(floodDecision.action || "timeout").toLowerCase();
            actions_attempted.push("flood");
            actions_results.push({
                dryRun: true,
                label: "flood",
                would: {
                    action: floodAction,
                    duration_seconds: floodDecision.duration_seconds || 0,
                    reason: "flood_guard",
                    target: event.senderUsername,
                },
            });
        }

        if (swarmDecision?.matched && Array.isArray(swarmDecision.actions) && swarmDecision.actions.length) {
            actions_attempted.push("swarm");
            actions_results.push({
                dryRun: true,
                label: "swarm",
                would: {
                    actions: swarmDecision.actions.map((a) => ({
                        action: a.action || "timeout",
                        target: a.targetUsername || a.target_username || event.senderUsername,
                        reason: a.reason || "swarm",
                    })),
                },
            });
        }

        if (moderationDecision?.matched) {
            const actionPayload = decisionToActionPayload
                ? decisionToActionPayload({ decision: moderationDecision, event })
                : moderationDecision;

            actions_attempted.push("moderation");
            actions_results.push({
                dryRun: true,
                label: "moderation",
                would: {
                    action: actionPayload?.action || moderationDecision.action || "none",
                    duration_seconds: actionPayload?.duration_seconds || moderationDecision.duration_seconds || 0,
                    reason:
                        actionPayload?.reason ||
                        moderationDecision?.explain?.match_reason ||
                        "rule_match",
                    target: event.senderUsername,
                    rule: moderationDecision.rule || null,
                },
            });
        }

        // Command result shape
        const commandMatched =
            typeof commandDecision === "string"
                ? !!String(commandDecision).trim()
                : !!(commandDecision?.matched || commandDecision?.text || commandDecision?.response?.text);

        const commandAllowed =
            commandMatched &&
            !(commandDecision?.error) &&
            !(commandDecision?.denied);

        if (commandMatched) {
            actions_attempted.push("command");
            actions_results.push({
                dryRun: true,
                label: "command",
                would: {
                    action: "reply",
                    text: typeof commandDecision === "string"
                        ? commandDecision
                        : (commandDecision?.text || commandDecision?.response?.text || "(matched)"),
                    target: event.senderUsername,
                },
            });
        }

        lastResult = {
            event_index: i,
            userRole,
            text_preview: String(event.text || "").slice(0, 120),
            trust: trustDecision || null,
            flood: floodDecision || null,
            swarm: swarmDecision || null,
            moderation: moderationDecision || null,
            command: commandDecision || null,
            command_allowed: commandAllowed,
            actions_attempted,
            actions_results,
        };

        results.push(lastResult);

        // Record to audit ring
        metricsRecordAudit({
            test_run_id,
            event_id: `test-${test_run_id}-evt-${i}`,
            message_id: event.message_id,
            channelSlug: event.channelSlug,
            senderUsername: event.senderUsername,
            senderUserId: event.senderUserId,
            userRole,
            text_preview: event.text,
            floodDecision,
            swarmDecision,
            moderationDecision,
            commandDecision,
            trustDecision,
            actions_attempted,
            actions_results,
        });
    }

    return {
        ok: true,
        test_run_id,
        test_id: testCase.id,
        test_name: testCase.name,
        category: testCase.category,
        event_count: events.length,
        // "last" is the final event's result — the one assertions run against
        last: lastResult,
        // all events for multi-step inspection
        all_events: results,
    };
}

// ─── Assertion Evaluator ────────────────────────────────

function getNestedValue(obj, path) {
    if (!obj || !path) return undefined;
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

export function evaluateAssertions(pipelineResult, assertions = []) {
    if (!pipelineResult?.last) {
        return assertions.map((a) => ({
            ...a,
            pass: false,
            actual: undefined,
            reason: "No pipeline result",
        }));
    }

    const target = pipelineResult.last;

    return assertions.map((assertion) => {
        const { path } = assertion;
        const actual = getNestedValue(target, path);

        if ("equals" in assertion) {
            const pass = actual === assertion.equals;
            return { ...assertion, pass, actual, reason: pass ? "OK" : `Expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}` };
        }

        if ("includes" in assertion) {
            const pass = Array.isArray(actual) && actual.includes(assertion.includes);
            return { ...assertion, pass, actual, reason: pass ? "OK" : `Array at ${path} does not include ${JSON.stringify(assertion.includes)}` };
        }

        if ("truthy" in assertion) {
            const pass = assertion.truthy ? !!actual : !actual;
            return { ...assertion, pass, actual, reason: pass ? "OK" : `Expected ${assertion.truthy ? "truthy" : "falsy"}, got ${JSON.stringify(actual)}` };
        }

        if ("exists" in assertion) {
            const pass = assertion.exists ? actual !== undefined && actual !== null : (actual === undefined || actual === null);
            return { ...assertion, pass, actual: actual !== undefined && actual !== null, reason: pass ? "OK" : `Expected ${assertion.exists ? "exists" : "not exists"}` };
        }

        return { ...assertion, pass: false, actual, reason: "Unknown assertion type" };
    });
}
