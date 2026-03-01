// src/intel/registerClassifier.js
import { isEmojiOnly } from '../lib/textSig.js';
// Deterministic register classifier (1..5) for live chat messages.
// - Fast: string/regex + tiny token tables
// - Stateless: no DB, no external calls
// - Explainable: returns axis scores + matched markers
//
// Register meaning here is "engagement bandwidth / cognitive posture",
// NOT intent and NOT moderation evidence.
//
// Output:
//   scoreText(text) -> {
//     register: 1..5,
//     score: number,
//     axes: { density, abstraction, rigor, pacing, directness, inference },
//     matches: { classes: string[], markers: string[] },
//     meta: { length, tokens, hasQuestion, hasMentions, hasLinks, emojiOnly }
//   }

const DEFAULTS = {
  // Axis weights (tunable later; keep stable for v1.5)
  weights: {
    density: 1.2,
    abstraction: 1.5,
    rigor: 1.4,
    pacing: 1.0,
    directness: 0.8,
    inference: 1.1,
  },

  // Score → register tiers (0..~21)
  tiers: [
    { max: 4, register: 1 },
    { max: 8, register: 2 },
    { max: 12, register: 3 },
    { max: 16, register: 4 },
    { max: 21, register: 5 },
  ],

  // Clamp ranges for axes (0..3)
  axisMin: 0,
  axisMax: 3,
};

// Minimal “speech-act” / functional comparator table.
// This is NOT a semantic dictionary. It's a small set of stable chat markers.
const TOKEN_CLASSES = [
  {
    name: "expressive",
    tokens: ["wtf", "wth", "omg", "bruh", "bro", "yo", "holy", "damn", "nah", "what??", "wut"],
    markers: ["!!!", "?!", "??", "?!?"],
  },
  {
    name: "affective",
    tokens: ["lol", "lmao", "lmfao", "rofl", "haha", "hehe", "kek", "xd"],
    markers: [],
  },
  {
    name: "directive",
    tokens: ["explain", "show", "tell", "clarify", "help", "fix", "prove", "define", "summarise", "summarize"],
    markers: [],
  },
  {
    name: "interrogative",
    tokens: ["why", "what", "how", "when", "where", "who", "which"],
    markers: ["?"],
  },
  {
    name: "evaluative",
    tokens: ["cap", "mid", "cringe", "based", "fire", "trash", "insane", "wild", "cooked", "goated", "w", "l"],
    markers: [],
  },
  {
    name: "agreement",
    tokens: ["fr", "frfr", "facts", "true", "real", "legit", "bet", "yep", "yup"],
    markers: [],
  },
  {
    name: "confusion",
    tokens: ["huh", "idk", "wat", "confused", "eh", "?", "??", "???"],
    markers: ["???", "??"],
  },
  {
    name: "meta",
    tokens: [
      "mechanism",
      "structure",
      "underlying",
      "model",
      "pattern",
      "architecture",
      "tradeoff",
      "invariant",
      "signal",
      "pipeline",
      "envelope",
      "schema",
      "deterministic",
      "governance",
      "heuristic",
      "abstraction",
      "rigor",
      "epistemic",
    ],
    markers: [],
  },
  {
    name: "intensity",
    tokens: ["literally", "actually", "deadass", "no shot", "ong", "on god"],
    markers: ["ALLCAPS"],
  },
  {
    name: "sarcasm",
    tokens: ["sure", "right", "okay buddy", "nice", "great", "smh"],
    markers: [],
  },
];

// Helpers
function clamp(n, min, max) {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeText(text) {
  return (text || "").trim();
}

function tokenize(text) {
  // Keep it simple: split on whitespace + punctuation boundaries.
  // We also keep a lowercase version for token matching.
  const t = normalizeText(text);
  if (!t) return [];
  return t
    .toLowerCase()
    .split(/[\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function hasLink(text) {
  return /https?:\/\/|www\./i.test(text || "");
}

function countSeparators(text) {
  // Used as a light proxy for pacing/topic transitions.
  // “/”, “—”, “;”, “…” and “->” are common in your high-bandwidth messages.
  const t = text || "";
  const matches = t.match(/(\-\>|—|;|\.\.\.|\/)/g);
  return matches ? matches.length : 0;
}

function countConjunctions(tokens) {
  // A crude density proxy.
  const set = new Set(["and", "but", "so", "also", "then", "because", "though", "however"]);
  let n = 0;
  for (const tok of tokens) if (set.has(tok)) n++;
  return n;
}

function detectClasses(text, tokens) {
  const classes = new Set();
  const markers = new Set();

  const raw = text || "";
  const lower = raw.toLowerCase();

  // ALLCAPS marker (common intensity)
  if (/[A-Z]{4,}/.test(raw)) markers.add("ALLCAPS");

  for (const cls of TOKEN_CLASSES) {
    // token hits
    for (const token of cls.tokens) {
      if (!token) continue;
      if (token.includes(" ")) {
        if (lower.includes(token)) {
          classes.add(cls.name);
          markers.add(`token:${token}`);
        }
      } else {
        // exact token match OR substring match for short chat tokens
        if (tokens.includes(token) || lower === token || lower.includes(` ${token} `)) {
          classes.add(cls.name);
          markers.add(`token:${token}`);
        }
      }
    }

    // marker hits
    for (const m of cls.markers) {
      if (!m) continue;
      if (m === "ALLCAPS") {
        if (markers.has("ALLCAPS")) classes.add(cls.name);
      } else if (raw.includes(m)) {
        classes.add(cls.name);
        markers.add(`marker:${m}`);
      }
    }
  }

  return {
    classes: Array.from(classes),
    markers: Array.from(markers),
  };
}

function scoreAxes(text) {
  const raw = normalizeText(text);
  const tokens = tokenize(raw);
  const length = raw.length;

  const meta = {
    length,
    tokens: tokens.length,
    hasQuestion: raw.includes("?"),
    hasMentions: /@\w+/.test(raw),
    hasLinks: hasLink(raw),
    emojiOnly: isEmojiOnly(raw),
  };

  const { classes, markers } = detectClasses(raw, tokens);

  // Axis: Density (0..3)
  // Uses: token count + conjunctions + multi-question + separators
  const qCount = (raw.match(/\?/g) || []).length;
  const conj = countConjunctions(tokens);
  const seps = countSeparators(raw);

  let density = 0;
  if (tokens.length >= 6) density++;
  if (tokens.length >= 14 || conj >= 2) density++;
  if (tokens.length >= 24 || qCount >= 2 || seps >= 2) density++;
  density = clamp(density, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Axis: Abstraction (0..3)
  // Uses: meta class + conceptual markers + “why/how/underlying” patterns
  let abstraction = 0;
  if (classes.includes("interrogative")) abstraction = Math.max(abstraction, 1);
  if (classes.includes("directive")) abstraction = Math.max(abstraction, 1);
  if (classes.includes("meta")) abstraction = Math.max(abstraction, 2);

  // “conversation about the conversation” / architecture-y patterns
  if (/\b(meta|framework|architecture|event shape|contract|envelope|state machine)\b/i.test(raw)) {
    abstraction = Math.max(abstraction, 3);
  }
  abstraction = clamp(abstraction, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Axis: Epistemic rigor (0..3)
  // Uses: directives/questions + mechanism-seeking phrases + constraint setting
  let rigor = 0;
  if (classes.includes("directive") || classes.includes("interrogative")) rigor = 1;
  if (/\b(specifically|mechanically|root cause|prove|disambiguate|invariant|signals?)\b/i.test(raw)) rigor = 2;
  if (/\b(show me|give me|exact|deterministic|implementation|schema|interface)\b/i.test(raw)) rigor = Math.max(rigor, 2);
  if (/\b(chain of thought)\b/i.test(raw)) rigor = 3; // signal only
  rigor = clamp(rigor, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Axis: Pacing (0..3)
  // Uses: separators + topic shifts + “ok but / however / aside”
  let pacing = 0;
  if (seps >= 1) pacing = 1;
  if (seps >= 2 || /\b(okay but|that aside|however|anyway|meanwhile|also)\b/i.test(raw)) pacing = 2;
  if (seps >= 3 || /\b(on the other hand|zoom out|big picture|switching gears)\b/i.test(raw)) pacing = 3;
  pacing = clamp(pacing, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Axis: Tone directness (0..3)
  // Uses: short imperative forms, low hedging, intensity markers
  let directness = 0;
  const hedges = (raw.match(/\b(maybe|sort of|kinda|i guess|perhaps)\b/gi) || []).length;
  if (length <= 10) directness = 2; // short blunt utterances
  if (classes.includes("directive")) directness = Math.max(directness, 2);
  if (classes.includes("intensity") || /!{2,}/.test(raw)) directness = Math.max(directness, 2);
  if (hedges === 0 && length >= 18) directness = Math.max(directness, 2);
  if (hedges === 0 && (classes.includes("meta") || rigor >= 2)) directness = Math.max(directness, 3);
  directness = clamp(directness, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Axis: Inference load (0..3)
  // Uses: pronouns, ellipsis, implied references, compressed context
  let inference = 0;
  const pronouns = (raw.match(/\b(this|that|it|they|those|these)\b/gi) || []).length;
  if (pronouns >= 2) inference = 1;
  if (/\b(as we said|like before|as discussed|you know|that thing)\b/i.test(raw) || raw.includes("...")) inference = 2;
  if (pronouns >= 4 || /\b(you already know|obviously|as per)\b/i.test(raw)) inference = 3;
  inference = clamp(inference, DEFAULTS.axisMin, DEFAULTS.axisMax);

  // Emoji-only should not score high-bandwidth.
  if (meta.emojiOnly) {
    density = 0;
    abstraction = 0;
    rigor = 0;
    pacing = 0;
    inference = 0;
    directness = Math.min(directness, 2); // keep some “tone” if it’s like “!!!”
  }

  return {
    axes: { density, abstraction, rigor, pacing, directness, inference },
    matches: { classes, markers },
    meta,
  };
}

function axesToScore(axes, weights) {
  const w = weights || DEFAULTS.weights;
  const score =
    axes.density * w.density +
    axes.abstraction * w.abstraction +
    axes.rigor * w.rigor +
    axes.pacing * w.pacing +
    axes.directness * w.directness +
    axes.inference * w.inference;

  // Keep one decimal for debugging; register mapping uses this score.
  return Math.round(score * 10) / 10;
}

function scoreToRegister(score, tiers) {
  const t = tiers || DEFAULTS.tiers;
  for (const tier of t) {
    if (score <= tier.max) return tier.register;
  }
  return 5;
}

export function scoreText(text, opts = {}) {
  const cfg = {
    weights: opts.weights || DEFAULTS.weights,
    tiers: opts.tiers || DEFAULTS.tiers,
  };

  const { axes, matches, meta } = scoreAxes(text);
  const score = axesToScore(axes, cfg.weights);
  const register = scoreToRegister(score, cfg.tiers);

  return {
    register,
    score,
    axes,
    matches,
    meta,
  };
}

// Convenience default export
export default {
  scoreText,
};
