'use strict';

/**
 * §36 - one shape for every automatic action.
 *
 * The point is that a failure is as visible as a success. A line is only ever
 * printed with the result that actually happened, so "Result: SUCCESS" cannot
 * appear for an operation that threw.
 *
 *   [2026-09-21 21:20:42 Africa/Nairobi] Feature: AutoReactMsg Chat: 123@g.us
 *   Sender: 2547… Reaction: 🔥 Result: SUCCESS
 */

const { logPrefix } = require('./time');
const { redact } = require('./redact');

const FIELDS = ['feature', 'chat', 'sender', 'target', 'executor', 'action', 'reaction', 'reason'];

function createDebugLog({ enabled = true, sink = console.log } = {}) {
  function line(entry = {}) {
    if (!enabled) return '';
    const parts = [`${logPrefix()}`];
    for (const field of FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || value === '') continue;
      const label = field.charAt(0).toUpperCase() + field.slice(1);
      parts.push(`${label}: ${redact(String(value))}`);
    }
    parts.push(`Result: ${entry.error ? `FAILED (${redact(String(entry.error))})` : 'SUCCESS'}`);
    return parts.join(' ');
  }

  /** Logs and returns the built line, so callers can assert on it in tests. */
  function log(entry) {
    const text = line(entry);
    if (text) sink(text);
    return text;
  }

  /**
   * Wraps an operation so the result reflects reality: the callback runs, and the
   * entry is written with SUCCESS only if it resolved. A throw is recorded as
   * FAILED and re-reported rather than swallowed into a success line.
   */
  async function run(entry, operation) {
    try {
      const value = await operation();
      log({ ...entry, error: null });
      return { ok: true, value };
    } catch (error) {
      log({ ...entry, error: error?.message || String(error) });
      return { ok: false, error };
    }
  }

  return { log, line, run, enabled };
}

module.exports = { createDebugLog };
