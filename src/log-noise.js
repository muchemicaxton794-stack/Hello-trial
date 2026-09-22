'use strict';

/**
 * Quietens two specific console habits of libsignal, a Baileys dependency.
 *
 * libsignal ignores the pino logger handed to Baileys and writes straight to the
 * console (`src/session_record.js:273`, `src/session_cipher.js:159`), so no log
 * level can filter it. That leaves:
 *
 *   - "Closing session: SessionEntry {...}" (session_record.js:273) - a routine
 *     ratchet close, dumped as a full session record with private keys in it.
 *   - "Closing open session in favor of incoming prekey bundle"
 *     (session_builder.js:74) - also routine, a session being re-established.
 *   - one full stack trace per undecryptable message ("Bad MAC",
 *     "Failed to decrypt message with any known session"). In a burst these bury
 *     the `[in]` lines you actually want to read.
 *
 * Routine session churn is dropped, and decrypt failures are counted and
 * reported once per interval instead of per message. Nothing else is touched.
 */

function installLogFilters({ log = console.log, intervalMs = 60000 } = {}) {
  const original = { info: console.info, warn: console.warn, error: console.error };

  let badMac = 0;
  let timer = null;

  const scheduleSummary = () => {
    if (timer) return;
    timer = setTimeout(() => {
      log(
        `[signal] ${badMac} message(s) could not be decrypted in the last ` +
          `${Math.round(intervalMs / 1000)}s. Usually self-healing; it also happens when two ` +
          'processes share one session/ directory.'
      );
      badMac = 0;
      timer = null;
    }, intervalMs);
    timer.unref?.();
  };

  const ROUTINE = [
    'Closing session:',
    'Session already closed',
    'Removing old closed session:', // third session-record dump in the same file
    'Closing open session in favor of incoming prekey bundle'
  ];

  const DECRYPT_FAILURES = [
    'Bad MAC',
    'Failed to decrypt message with any known session',
    'Key used already or never filled', // MessageCounterError
    'MessageCounterError'
  ];

  const isRoutine = first => typeof first === 'string' && ROUTINE.some(prefix => first.startsWith(prefix));

  const isDecryptFailure = args =>
    args.some(argument => typeof argument === 'string' && DECRYPT_FAILURES.some(needle => argument.includes(needle)));

  console.info = (...args) => {
    if (isRoutine(args[0])) return;
    original.info(...args);
  };

  console.warn = (...args) => {
    if (isRoutine(args[0])) return;
    original.warn(...args);
  };

  console.error = (...args) => {
    if (isDecryptFailure(args)) {
      badMac += 1;
      scheduleSummary();
      return;
    }
    original.error(...args);
  };

  return {
    uninstall() {
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get badMacCount() {
      return badMac;
    }
  };
}

module.exports = { installLogFilters };
