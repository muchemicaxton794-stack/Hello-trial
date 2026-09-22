'use strict';

/**
 * Unlinks the currently paired account: `npm run unlink`
 *
 * Calls Baileys' logout(), which asks WhatsApp to remove this companion. That
 * matters - simply deleting session/ leaves a dead entry sitting in the phone's
 * "Linked devices" list, and WhatsApp can keep delivering to it.
 *
 * The session directory is NOT deleted here. Run this first, confirm it reports
 * success, then remove session/ (the printed command does it).
 *
 * Stop the bot before running: two live sockets on one companion registration
 * fight over it.
 */

const P = require('pino');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

const TIMEOUT_MS = Number(process.env.UNLINK_TIMEOUT_MS || 45000);

(async () => {
  if (!fs.existsSync(path.join(config.SESSION_DIR, 'creds.json'))) {
    console.log('[unlink] no session to unlink (session/creds.json is missing). Nothing to do.');
    return;
  }

  const { state } = await useMultiFileAuthState(config.SESSION_DIR);
  console.log(`[unlink] paired account: ${state.creds.me?.id || 'unknown'}`);

  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  let finished = false;

  const done = (code, message) => {
    if (finished) return;
    finished = true;
    console.log(message);
    try {
      socket.end(undefined);
    } catch {
      /* already gone */
    }
    setTimeout(() => process.exit(code), 400).unref?.();
  };

  const timer = setTimeout(
    () => done(1, '[unlink] timed out waiting for the connection; nothing was unlinked.'),
    TIMEOUT_MS
  );

  socket.ev.on('connection.update', async update => {
    if (update.connection !== 'open') return;
    clearTimeout(timer);
    try {
      await socket.logout('Unlinked from the bot console');
      done(
        0,
        '[unlink] SUCCESS - this companion has been removed from WhatsApp.\n' +
          `[unlink] now delete the session:  gio trash "${path.relative(config.ROOT, config.SESSION_DIR)}"`
      );
    } catch (error) {
      done(1, `[unlink] FAILED: ${error?.message || error}`);
    }
  });

  socket.ev.on('creds.update', () => {});
})().catch(error => {
  console.error(`[unlink] error: ${error?.message || error}`);
  process.exit(1);
});
