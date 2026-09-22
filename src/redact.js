'use strict';

/**
 * Masks credentials in anything the bot logs.
 *
 * The console prints a preview of every message in and out, which is what makes
 * it useful - and what makes it dangerous. People paste tokens into chats, so a
 * log file quietly becomes a credential store.
 *
 * Only well-known, unambiguous key formats are matched, so ordinary conversation
 * is left alone. The scheme prefix and the length are kept: that is enough to
 * recognise *which* key leaked without keeping the secret itself.
 */

const PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq
  /\bmzazi_[A-Za-z0-9]{10,}\b/g, // Mzazi API
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g // Telegram bot token
];

const PREFIX = /^(gh[pousr]_|sk-|gsk_|mzazi_|AKIA|xox[baprs]-|AIza)/;

function mask(match) {
  const prefix = match.match(PREFIX)?.[1] || '';
  return `${prefix}«redacted:${match.length}»`;
}

/** Returns `text` with any recognisable credential replaced by a marker. */
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  return PATTERNS.reduce((result, pattern) => result.replace(pattern, mask), text);
}

/** Log previews honour LOG_MESSAGE_TEXT=false by dropping the body entirely. */
function previewText(text, { hideText = false } = {}) {
  if (typeof text !== 'string' || !text) return text;
  if (hideText) return `[text hidden: ${text.length} chars]`;
  return redact(text);
}

module.exports = { redact, previewText, PATTERNS };
