// src/lib/textSig.js
import crypto from 'crypto';

export function normalizeExact(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/\u200B|\u200C|\u200D|\uFEFF/g, '');   // zero-width
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/\s+/g, ' ').trim();
  // Keep URLs, strip most punctuation
  t = t.replace(/(https?:\/\/\S+)/g, ' $1 ');
  t = t.replace(/[^\p{L}\p{N}\s:/.?_=&%-]+/gu, '');   // unicode letters/numbers
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function normalizeFuzzy(text) {
  let t = normalizeExact(text);
  // collapse repeated characters: heyyyy -> heyy
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  // drop digits (bots vary numbers)
  t = t.replace(/\d+/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function hashSig(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

export function capsRatio(text) {
  const t = String(text || '');
  const letters = t.match(/[A-Za-z]/g) || [];
  if (!letters.length) return 0;
  const caps = t.match(/[A-Z]/g) || [];
  return caps.length / letters.length;
}

export function hasUrl(text) {
  return /https?:\/\/\S+|www\.\S+/i.test(String(text || ''));
}

export function stripEmoji(text) {
  const s = String(text || '');
  try {
    return s
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[\uFE0F\u200D]/g, '')
      .trim();
  } catch {
    return s.trim();
  }
}

export function isEmojiOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/[a-z0-9]/i.test(raw)) return false;
  const noEmoji = stripEmoji(raw);
  if (!noEmoji) return true;
  try {
    const meaningful = noEmoji.replace(/[\s\p{P}\p{S}]/gu, '');
    return meaningful.length === 0;
  } catch {
    return !/[a-z0-9]/i.test(noEmoji);
  }
}

