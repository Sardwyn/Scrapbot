// src/moderation/commandTestCases.js
// Deterministic command test cases for the Test Lab.

export const COMMAND_TEST_CASES = [
    {
        id: "cmd_basic_text",
        name: "Basic Text Command",
        category: "commands",
        description: "Simple !hello command check. Expects a plain text actions[0].text reply.",
        setup: {
            messageText: "!hello",
            userRole: "everyone",
            userName: "viewer_tom",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: true },
            { path: "command.actions.0.type", equals: "chat" },
            { path: "command.actions.0.text", exists: true }
        ]
    },
    {
        id: "cmd_permission_denied",
        name: "Mod-Only Permission Denied",
        category: "commands",
        description: "Viewer tries a mod-only command. Expects no match.",
        setup: {
            messageText: "!modonly",
            userRole: "everyone",
            userName: "viewer_tom",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: false }
        ]
    },
    {
        id: "cmd_permission_allow",
        name: "Mod-Only Permission Allowed",
        category: "commands",
        description: "Moderator uses a mod-only command. Expects success.",
        setup: {
            messageText: "!modonly",
            userRole: "mod",
            userName: "mod_jane",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: true },
            { path: "command.actions.length", equals: 1 }
        ]
    },
    {
        id: "cmd_cooldown_active",
        name: "Cooldown Enforcement",
        category: "commands",
        description: "Repeat use of a command with cooldown. Expects denied: true on second use.",
        setup: {
            // Logic for this test will be handled by the runner (running twice)
            messageText: "!help",
            userRole: "everyone",
            userName: "viewer_tom",
            channelSlug: "testchannel",
            repeat: 2
        },
        assert: [
            { path: "command.denied", equals: true },
            { path: "command.reason", equals: "cooldown" }
        ]
    },
    {
        id: "cmd_template_expansion",
        name: "Template Expansion {user}",
        category: "commands",
        description: "Verify {user} expands to the sender username.",
        setup: {
            messageText: "!shoutout",
            userRole: "everyone",
            userName: "test_user_alpha",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: true },
            { path: "command.actions.0.text", includes: "test_user_alpha" }
        ]
    },
    {
        id: "cmd_args_parsing",
        name: "Argument Parsing ($1)",
        category: "commands",
        description: "Tests !so @user. Expects $1 to resolve to @user.",
        setup: {
            messageText: "!so @gigachad",
            userRole: "everyone",
            userName: "viewer_tom",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: true },
            { path: "command.actions.0.text", includes: "@gigachad" }
        ]
    },
    {
        id: "cmd_dsl_random",
        name: "DSL $random()",
        category: "commands",
        description: "Tests a command that uses $random(yes,no,maybe).",
        setup: {
            messageText: "!ask am i cool?",
            userRole: "everyone",
            userName: "viewer_tom",
            channelSlug: "testchannel"
        },
        assert: [
            { path: "command.matched", equals: true },
            { path: "command.actions.0.text", exists: true }
        ]
    }
];

export function getCommandTestCaseById(id) {
    return COMMAND_TEST_CASES.find((t) => t.id === id) || null;
}

export function listCommandTestCases() {
    return COMMAND_TEST_CASES.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description
    }));
}
