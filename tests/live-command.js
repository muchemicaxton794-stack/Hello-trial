'use strict';

/**
 * Live end-to-end command test: `npm run test-live`
 *
 * Reproduces the exact scenario that made the bot look dead: a command sent from
 * the linked account itself, which arrives back with `fromMe: true`.
 *
 * It connects with the saved session, sends `.ping` into its own chat, and waits
 * for the reply. A PASS means the inbound pipeline saw the fromMe message and the
 * dispatcher answered.
 *
 * Notes:
 *  - Stop the bot before running this. Two live sockets sharing one companion
 *    registration fight over each other.
 *  - The probe is sent through the pre-wrap sendMessage, which stands in for the
 *    phone: a real phone message is not tracked as "self-sent", while the bot's
 *    own replies are.
 */

const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const config = require('../src/config');
const { createStore, createObjectStore } = require('../src/store');
const { createMessageTools, GROUP_DEFAULTS } = require('../src/msg');
const { createInboundHandler } = require('../src/inbound');
const { runBigBroCommand } = require('../src/bigbro');

const PROBE = process.env.LIVE_COMMAND || '.ping';
const EXPECT = /Pong/;
const TIMEOUT_MS = Number(process.env.LIVE_COMMAND_TIMEOUT_MS || 60000);

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);
  if (!state.creds?.registered) {
    console.error('This session is not linked. Run `npm start` and pair first.');
    process.exitCode = 1;
    return;
  }

  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  socket.ev.on('creds.update', saveCreds);

  // Captured BEFORE createMessageTools wraps sendMessage - this is the "phone".
  const externalSend = socket.sendMessage.bind(socket);

  const tools = {
    ...createMessageTools({
      socket,
      botName: config.BOT_NAME,
      prefix: config.PREFIX,
      mode: 'self',
      settingsStore: createObjectStore({ file: config.SETTINGS_FILE, defaults: GROUP_DEFAULTS }),
      ownersStore: createStore({ file: config.OWNERS_FILE, defaults: { owners: [] } }),
      globalStore: createStore({ file: config.GLOBAL_FILE, defaults: { anticall: false, mode: '', pairWelcomePending: false, pairWelcomeAttempts: 0 } })
    }),
    menuImageUrl: config.MENU_IMAGE_URL,
    menuImagePath: config.MENU_IMAGE_PATH
  };

  const seen = [];
  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: line => {
      seen.push(line);
      console.log(line);
    }
  });

  const replies = [];
  const originalSend = socket.sendMessage;
  socket.sendMessage = async (jid, content, extra) => {
    if (content?.text) replies.push(content.text);
    return originalSend(jid, content, extra);
  };

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const message of messages) {
      try {
        await handleInbound(message, type);
      } catch (error) {
        console.error('inbound failed:', error?.message || error);
      }
    }
  });

  const selfJid = jidNormalizedUser(state.creds.me.id);
  console.log(`[live] session: ${state.creds.me.id}`);
  console.log(`[live] will send "${PROBE}" to ${selfJid} (its own chat)\n`);

  const verdict = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timed out' }), TIMEOUT_MS);

    socket.ev.on('connection.update', async update => {
      if (update.connection === 'open') {
        setTimeout(async () => {
          try {
            await externalSend(selfJid, { text: PROBE });
            console.log(`[live] probe sent: ${PROBE}`);
          } catch (error) {
            clearTimeout(timer);
            resolve({ ok: false, reason: `probe send failed: ${error?.message || error}` });
          }
        }, 2000);
        return;
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        clearTimeout(timer);
        resolve({ ok: false, reason: `connection closed (${code ?? 'unknown'})` });
      }
    });

    const interval = setInterval(() => {
      const reply = replies.find(text => EXPECT.test(text));
      if (reply) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve({ ok: true, reply });
      }
    }, 500);
  });

  console.log('');
  console.log('[live] inbound lines observed:');
  for (const line of seen) console.log(`  ${line}`);
  console.log('');
  if (verdict.ok) console.log(`[live] PASS - command detected and answered with: ${JSON.stringify(verdict.reply)}`);
  else console.log(`[live] FAIL - ${verdict.reason}`);

  setTimeout(() => {
    try {
      socket.end(undefined);
    } catch {
      /* already closed */
    }
    process.exit(verdict.ok ? 0 : 1);
  }, 1500);
})().catch(error => {
  console.error('[live] failed:', error?.message || error);
  process.exitCode = 1;
});
