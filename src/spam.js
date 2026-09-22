'use strict';

/**
 * One SpamManager for the whole bot (AntiSpam / AntiMessage / AutoBlock).
 *
 * Detection is deliberately conservative. The rules that matter, straight from the
 * requirement:
 *
 *   - A single long message is NEVER spam. Length alone never triggers anything.
 *   - "hello hello hello hello hello"      -> duplicate flood
 *   - "sgsjsyshsgsuegdiwnshgdhd jsjsjsjsjs" -> random-character flood
 *   - normal conversation                  -> nothing, ever
 *
 * Everything is per (chat, sender), bounded by a sliding window, and swept so a
 * long-lived process cannot leak memory.
 */

const KNOWN_ACTIONS = ['delete', 'warn', 'kick', 'block', 'none'];

/** "delete+warn" -> ['delete','warn']; unknown parts are reported, not guessed. */
function parseActions(value) {
  const parts = String(value || '')
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
  const actions = [];
  const unknown = [];
  for (const part of parts) {
    if (!KNOWN_ACTIONS.includes(part)) unknown.push(part);
    else if (part !== 'none' && !actions.includes(part)) actions.push(part);
  }
  return { actions, unknown };
}

const VOWELS = new Set([...'aeiouAEIOU']);

/**
 * True when a single token looks like keyboard mashing rather than a word.
 *
 * Requires a long token AND (almost no vowels OR a very long consonant run), so
 * "strengths", "ng'ang'ana" and long URLs do not qualify.
 */
function looksRandom(token) {
  const letters = token.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 12) return false;

  const vowels = [...letters].filter(character => VOWELS.has(character)).length;
  const vowelRatio = vowels / letters.length;
  if (vowelRatio < 0.18) return true;

  let run = 0;
  let longest = 0;
  for (const character of letters) {
    if (VOWELS.has(character)) {
      run = 0;
    } else {
      run += 1;
      longest = Math.max(longest, run);
    }
  }
  return longest >= 9;
}

/** Counts tokens that look mashed, ignoring normal prose. */
function randomTokenCount(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter(looksRandom).length;
}

function createSpamManager({
  windowSeconds = 10,
  messageLimit = 6,
  duplicateLimit = 3,
  randomLimit = 2,
  action = 'delete+warn',
  warnLimit = 2,
  maxTracked = 5000
} = {}) {
  const windowMs = windowSeconds * 1000;
  const parsed = parseActions(action);

  /** key -> [{ time, text }] */
  const history = new Map();
  /** key -> warnings already issued */
  const warnings = new Map();
  /** key -> last punishment timestamp, to stop duplicate punishment */
  const punished = new Map();

  const keyOf = (chatJid, senderJid) => `${chatJid}|${senderJid}`;

  function prune(entries, now) {
    while (entries.length && now - entries[0].time > windowMs) entries.shift();
  }

  /**
   * Records a message and decides whether it is spam.
   * @returns {{ spam: boolean, reason: string|null, count: number, duplicates: number,
   *            randomTokens: number, windowSeconds: number }}
   */
  function record(chatJid, senderJid, text, now = Date.now()) {
    const key = keyOf(chatJid, senderJid);
    const entries = history.get(key) || [];
    entries.push({ time: now, text: String(text || '') });
    prune(entries, now);
    history.set(key, entries);

    if (history.size > maxTracked) {
      const oldest = history.keys().next();
      if (!oldest.done) history.delete(oldest.value);
    }

    const count = entries.length;
    const duplicateOf = entries.filter(entry => entry.text && entry.text === String(text || '')).length;
    const randomTokens = randomTokenCount(text);
    const randomInWindow = entries.filter(entry => randomTokenCount(entry.text) > 0).length;

    let reason = null;
    if (count >= messageLimit) reason = 'flood';
    else if (duplicateOf >= duplicateLimit) reason = 'duplicate-flood';
    // Random-character flooding needs a repeat: one odd message is not a flood,
    // which also keeps a single long message from ever being classified as spam.
    else if (randomTokens > 0 && randomInWindow >= randomLimit) reason = 'random-flood';

    return { spam: Boolean(reason), reason, count, duplicates: duplicateOf, randomTokens, windowSeconds };
  }

  function reset(chatJid, senderJid) {
    history.delete(keyOf(chatJid, senderJid));
  }

  function warnCount(chatJid, senderJid) {
    return warnings.get(keyOf(chatJid, senderJid)) || 0;
  }

  function noteWarning(chatJid, senderJid) {
    const key = keyOf(chatJid, senderJid);
    warnings.set(key, warnCount(chatJid, senderJid) + 1);
  }

  function wasPunishedRecently(chatJid, senderJid, now = Date.now()) {
    const at = punished.get(keyOf(chatJid, senderJid));
    return Boolean(at) && now - at < windowMs;
  }

  function notePunished(chatJid, senderJid, now = Date.now()) {
    punished.set(keyOf(chatJid, senderJid), now);
  }

  /**
   * Warns only up to the configured limit, then reports that the next step is
   * escalation - so repeat offences move on instead of warning forever.
   */
  function nextWarning(chatJid, senderJid) {
    const used = warnCount(chatJid, senderJid);
    if (used >= warnLimit) return { issue: false, used, escalate: true };
    return { issue: true, used: used + 1, escalate: false };
  }

  /** Drops expired state so a long-running process does not grow forever. */
  function sweep(now = Date.now()) {
    for (const [key, entries] of history) {
      prune(entries, now);
      if (!entries.length) history.delete(key);
    }
    for (const [key, at] of punished) {
      if (now - at > windowMs * 6) punished.delete(key);
    }
    return { tracked: history.size };
  }

  return {
    windowSeconds,
    messageLimit,
    actions: parsed.actions,
    unknownActions: parsed.unknown,
    record,
    reset,
    nextWarning,
    noteWarning,
    wasPunishedRecently,
    notePunished,
    warnCount,
    sweep,
    size: () => history.size
  };
}

module.exports = { createSpamManager, parseActions, looksRandom, randomTokenCount, KNOWN_ACTIONS };
