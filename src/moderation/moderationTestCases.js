// src/moderation/moderationTestCases.js
// Deterministic test case definitions for the Moderation Test Lab.
// Each test describes inputs + expected assertions.

/**
 * Assertion format:
 *   { path: "field.subfield", equals: value }
 *   { path: "field", includes: value }          // array includes
 *   { path: "field", truthy: true/false }
 *   { path: "field", exists: true/false }
 */

export const MODERATION_TEST_CASES = [
    // ─── Flood Guard ───────────────────────────────────────
    {
        id: "flood_burst",
        name: "Flood Guard — Message Burst",
        category: "flood",
        description:
            "Simulates 15 rapid identical messages from the same user. Expects flood guard to trip and produce a timeout.",
        setup: {
            events: Array.from({ length: 15 }, (_, i) => ({
                text: "buy my product now! check this out!",
                senderUserId: "90001",
                senderUsername: "spambot_test",
                channelSlug: "testchannel",
                scraplet_user_id: 1,
                broadcasterUserId: "1017792",
                badges: [],
                userRole: "everyone",
            })),
        },
        assert: [
            { path: "flood.matched", equals: true },
            { path: "actions_attempted", includes: "flood" },
        ],
    },
    {
        id: "flood_mod_bypass",
        name: "Flood Guard — Mod Bypass",
        category: "flood",
        description:
            "Simulates rapid messages from a moderator. Expects flood guard to be skipped.",
        setup: {
            events: Array.from({ length: 15 }, () => ({
                text: "mod message mod message mod message",
                senderUserId: "90002",
                senderUsername: "mod_user_test",
                channelSlug: "testchannel",
                scraplet_user_id: 1,
                broadcasterUserId: "1017792",
                badges: ["moderator"],
                userRole: "mod",
            })),
        },
        assert: [
            { path: "flood.matched", equals: false },
            { path: "userRole", equals: "moderator" },
        ],
    },

    // ─── Moderation Rules ──────────────────────────────────
    {
        id: "rule_contains_match",
        name: "Rule — Contains Phrase Match",
        category: "moderation",
        description:
            "A message containing a blacklisted phrase should trigger a moderation rule match. Uses a synthetic rule injected at test time.",
        setup: {
            events: [
                {
                    text: "buy followers cheap guaranteed results",
                    senderUserId: "90003",
                    senderUsername: "bad_actor_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
            injectedRules: [
                {
                    id: 99901,
                    rule_type: "contains",
                    rule_value: "buy followers",
                    action: "timeout",
                    duration_seconds: 60,
                    enabled: true,
                    channel_slug: null,
                    ignore_mods: false,
                    priority: 1,
                },
            ],
        },
        assert: [
            { path: "moderation.matched", equals: true },
            { path: "moderation.action", equals: "timeout" },
            { path: "actions_attempted", includes: "moderation" },
        ],
    },
    {
        id: "rule_regex_match",
        name: "Rule — Regex Match",
        category: "moderation",
        description:
            "A message matching a regex pattern should trigger moderation.",
        setup: {
            events: [
                {
                    text: "check out https://scam-site.com/free-money",
                    senderUserId: "90004",
                    senderUsername: "link_spammer_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
            injectedRules: [
                {
                    id: 99902,
                    rule_type: "link_posting",
                    rule_value: "1",
                    action: "delete",
                    duration_seconds: 0,
                    enabled: true,
                    channel_slug: null,
                    ignore_mods: false,
                    priority: 1,
                },
            ],
        },
        assert: [
            { path: "moderation.matched", equals: true },
            { path: "moderation.action", equals: "delete" },
        ],
    },
    {
        id: "rule_caps_ratio",
        name: "Rule — Caps Ratio",
        category: "moderation",
        description:
            "An all-caps message should trigger the caps_ratio rule.",
        setup: {
            events: [
                {
                    text: "THIS IS ALL CAPS AND SHOULD BE MODERATED IMMEDIATELY",
                    senderUserId: "90005",
                    senderUsername: "caps_user_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
            injectedRules: [
                {
                    id: 99903,
                    rule_type: "caps_ratio",
                    rule_value: "0.8",
                    action: "timeout",
                    duration_seconds: 30,
                    enabled: true,
                    channel_slug: null,
                    ignore_mods: false,
                    priority: 1,
                },
            ],
        },
        assert: [
            { path: "moderation.matched", equals: true },
            { path: "moderation.action", equals: "timeout" },
        ],
    },
    {
        id: "rule_emoji_bypass",
        name: "Rule — Emoji-Only Bypass",
        category: "moderation",
        description:
            "An emoji-only message should NOT trigger any text-based moderation rules.",
        setup: {
            events: [
                {
                    text: "🎉🎉🎉🔥🔥🔥",
                    senderUserId: "90006",
                    senderUsername: "hype_user_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
            injectedRules: [
                {
                    id: 99904,
                    rule_type: "contains",
                    rule_value: "🎉",
                    action: "timeout",
                    duration_seconds: 30,
                    enabled: true,
                    channel_slug: null,
                    ignore_mods: false,
                    priority: 1,
                },
            ],
        },
        assert: [
            { path: "moderation.matched", equals: false },
        ],
    },
    {
        id: "rule_broadcaster_bypass",
        name: "Rule — Broadcaster Bypass",
        category: "moderation",
        description:
            "A broadcaster's message should never trigger moderation, even if it matches rules.",
        setup: {
            events: [
                {
                    text: "buy followers cheap",
                    senderUserId: "1017792",
                    senderUsername: "broadcaster_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: ["broadcaster"],
                    userRole: "broadcaster",
                },
            ],
            injectedRules: [
                {
                    id: 99905,
                    rule_type: "contains",
                    rule_value: "buy followers",
                    action: "ban",
                    duration_seconds: 0,
                    enabled: true,
                    channel_slug: null,
                    ignore_mods: false,
                    priority: 1,
                },
            ],
        },
        assert: [
            { path: "moderation.matched", equals: false },
            { path: "userRole", equals: "broadcaster" },
        ],
    },

    // ─── Swarm Guard ───────────────────────────────────────
    {
        id: "swarm_identical",
        name: "Swarm Guard — Identical Messages",
        category: "swarm",
        description:
            "Multiple distinct users sending the exact same message in a burst. May or may not trigger swarm depending on DB settings; test validates the pipeline runs without error.",
        setup: {
            events: Array.from({ length: 8 }, (_, i) => ({
                text: "free nitro at discord.gg/scam123",
                senderUserId: String(91000 + i),
                senderUsername: `swarm_bot_${i}`,
                channelSlug: "testchannel",
                scraplet_user_id: 1,
                broadcasterUserId: "1017792",
                badges: [],
                userRole: "everyone",
            })),
        },
        assert: [
            { path: "swarm", exists: true },
            // Swarm may or may not match depending on DB thresholds
        ],
    },

    // ─── Trust ─────────────────────────────────────────────
    {
        id: "trust_hostile",
        name: "Trust — Hostile Precheck",
        category: "trust",
        description:
            "Tests the trust hostile precheck pipeline. Since shouldAutoHostileAction requires DB state, this test validates the pipeline runs safely and reports the trust decision shape.",
        setup: {
            events: [
                {
                    text: "I am a suspicious user",
                    senderUserId: "90099",
                    senderUsername: "suspicious_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
        },
        assert: [
            { path: "trust", exists: true },
            // Trust score depends on DB state; just validate shape
        ],
    },

    // ─── Commands ──────────────────────────────────────────
    {
        id: "cmd_list_mod",
        name: "Command — !cmd list (Moderator)",
        category: "commands",
        description:
            "A moderator using !cmd list should get a command match response.",
        setup: {
            events: [
                {
                    text: "!cmd list",
                    senderUserId: "90010",
                    senderUsername: "mod_cmd_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: ["moderator"],
                    userRole: "moderator",
                },
            ],
        },
        assert: [
            { path: "command", exists: true },
        ],
    },
    {
        id: "cmd_viewer_denied",
        name: "Command — !cmd set (Viewer Denied)",
        category: "commands",
        description:
            "A viewer trying !cmd set should be denied (no match or error response).",
        setup: {
            events: [
                {
                    text: "!cmd set !hello Hello World",
                    senderUserId: "90011",
                    senderUsername: "viewer_cmd_test",
                    channelSlug: "testchannel",
                    scraplet_user_id: 1,
                    broadcasterUserId: "1017792",
                    badges: [],
                    userRole: "everyone",
                },
            ],
        },
        assert: [
            // Viewers can't use !cmd set — should not produce a successful command match
            { path: "command_allowed", equals: false },
        ],
    },
];

export function getTestCaseById(id) {
    return MODERATION_TEST_CASES.find((t) => t.id === id) || null;
}

export function listTestCases() {
    return MODERATION_TEST_CASES.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        event_count: t.setup?.events?.length || 0,
        assert_count: t.assert?.length || 0,
    }));
}
