'use strict';

/**
 * Sends the pairing welcome DM on demand: `npm run send-welcome`
 *
 * Uses the saved session in session/ - so it needs an already-paired account -
 * connects, delivers the message to the paired number's own chat, and exits.
 * Nothing else is sent, and the session is left untouched.
 *
 * Do not run this while another copy of the bot is running on the same session:
 * two live sockets sharing one companion registration fight over it.
 */

const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const config = require('../src/config');
const { createStore } = require('../src/store');
const { deliverPairWelcome, pairWelcomeText } = require('../src/welcome');

const TIMEOUT_MS = Number(process.env.SEND_WELCOME_TIMEOUT_MS || 60000);

(async () => {
  const globalStore = createStore({
    file: config.GLOBAL_FILE,
    defaults: { anticall: false, mode: '', pairWelcomePending: false, pairWelcomeAttempts: 0 }
  });

  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);
  if (!state.creds?.registered) {
    console.error('This session is not linked yet. Run `npm start` and pair first.');
    process.exitCode = 1;
    return;
  }

  console.log(`[send-welcome] opening the saved session (${state.creds.me?.id || 'unknown'})...`);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  socket.ev.on('creds.update', saveCreds);

  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ sent: false, reason: 'timed out waiting for the connection' }), TIMEOUT_MS);

    socket.ev.on('connection.update', async update => {
      if (update.connection === 'open') {
        clearTimeout(timer);
        resolve(await deliverPairWelcome({ socket, globalStore, text: config.PAIR_WELCOME, force: true }));
        return;
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        clearTimeout(timer);
        resolve({ sent: false, reason: `connection closed (${code ?? 'unknown'})` });
      }
    });
  });

  console.log('');
  console.log('[send-welcome] message text:');
  console.log(`  ${pairWelcomeText(config.PAIR_WELCOME)}`);
  console.log('');
  if (outcome.sent) console.log(`[send-welcome] delivered to ${outcome.jid}`);
  else console.error(`[send-welcome] not sent: ${outcome.reason}`);

  setTimeout(() => {
    try {
      socket.end(undefined);
    } catch {
      /* already closed */
    }
    process.exit(outcome.sent ? 0 : 1);
  }, 1500);
})().catch(error => {
  console.error('[send-welcome] failed:', error?.message || error);
  process.exitCode = 1;
});
