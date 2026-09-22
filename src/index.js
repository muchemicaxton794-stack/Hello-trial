'use strict';

const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { createStore, createObjectStore } = require('./store');
const { createMessageTools, GROUP_DEFAULTS } = require('./msg');
const { createSpamManager } = require('./spam');
const { createProtection } = require('./protected');
const { createDebugLog } = require('./debug-log');
const { createPairing } = require('./pairing');
const { markPairWelcomePending, deliverPairWelcome } = require('./welcome');
const { createInboundHandler } = require('./inbound');
const { installLogFilters } = require('./log-noise');
const { runBigBroCommand } = require('./bigbro');

const logger = P({ level: 'silent' });

// Process-wide singletons. Created before the socket so they survive reconnects:
// spam history and the LID directory must not reset every time the link drops.
const spamManager = createSpamManager({
  windowSeconds: config.SPAM_WINDOW_SECONDS,
  messageLimit: config.SPAM_MESSAGE_LIMIT,
  action: config.SPAM_ACTION,
  warnLimit: config.SPAM_WARN_LIMIT
});

const debug = createDebugLog({ enabled: config.DEBUG_LOG !== false });

// libsignal bypasses the Baileys logger and writes straight to the console; see
// src/log-noise.js for what that costs and what is filtered.
installLogFilters({ log: console.log });

// Reconnect backoff: grows to a cap instead of hammering the servers every 3s.
const BACKOFF_START_MS = 3000;
const BACKOFF_MAX_MS = 60000;

const settingsStore = createObjectStore({ file: config.SETTINGS_FILE, defaults: GROUP_DEFAULTS });
const ownersStore = createStore({ file: config.OWNERS_FILE, defaults: { owners: [] } });
const globalStore = createStore({
  file: config.GLOBAL_FILE,
  defaults: {
    anticall: false,
    mode: '',
    // Set when a brand-new device links; the welcome DM is sent once the socket
    // comes back up after the server-requested restart.
    pairWelcomePending: false,
    pairWelcomeAttempts: 0
  }
});

let reconnectDelay = BACKOFF_START_MS;
let shuttingDown = false;
let currentSocket = null;

function resolveMode() {
  const stored = globalStore.get('mode');
  return stored === 'public' || stored === 'self' ? stored : config.MODE;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // NOTE: `printQRInTerminal` is deliberately NOT passed. Baileys 6.6+ ignores it
  // apart from a deprecation warning, so the QR is handled by src/pairing.js.
  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  currentSocket = socket;

  const pairing = createPairing({
    socket,
    pairingNumber: config.PAIRING_NUMBER,
    pairingCode: config.PAIRING_CODE,
    botName: config.BOT_NAME,
    qrFile: config.QR_FILE,
    log: console.log,
    warn: console.warn
  });

  // `creds.registered` flipping to true only means our client finished SENDING
  // its half of the pairing exchange (lib/Socket/messages-recv.js:434) - it is
  // not server confirmation, and on its own it proves nothing. Log the
  // transition so a stalled handshake is visible instead of inferred.
  let sawRegistered = Boolean(state.creds.registered);
  socket.ev.on('creds.update', () => {
    // state.creds is the same object Baileys mutates, so no guessing at internals.
    const nowRegistered = Boolean(state.creds?.registered);
    if (nowRegistered && !sawRegistered) {
      sawRegistered = true;
      console.log(
        '🔐 pairing exchange sent; waiting for WhatsApp to confirm. If nothing follows within a ' +
          'minute, the companion was not accepted.'
      );
    }
    saveCreds();
  });

  socket.ev.on('connection.update', async update => {
    // A brand-new device was just linked. Baileys raises this *before* the
    // server-requested restart and without a `connection` field, so the welcome
    // is queued here and sent once the socket comes back up.
    if (update.isNewLogin) {
      markPairWelcomePending(globalStore);
      console.log('🔗 New device linked - the pairing welcome will be sent once the connection opens.');
    }

    try {
      await pairing.handle(update);
    } catch (error) {
      console.error('[pairing]', error?.message || error);
    }

    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnectDelay = BACKOFF_START_MS;
      console.log(`✅ ${config.BOT_NAME} connected as ${socket.user?.id || 'unknown'} (mode: ${resolveMode()})`);
      await deliverPairWelcome({ socket, globalStore, text: config.PAIR_WELCOME });
      return;
    }

    if (connection !== 'close') return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (shuttingDown) return;

    if (statusCode === DisconnectReason.loggedOut) {
      console.error(
        '❌ This session was logged out from the phone. Delete the session/ directory and pair again.'
      );
      process.exitCode = 1;
      socket.end(undefined);
      return;
    }

    if (statusCode === DisconnectReason.restartRequired) {
      reconnectDelay = BACKOFF_START_MS;
    }

    // The pending pairing request died with the connection, so let the next
    // attempt mint a usable one instead of holding a code WhatsApp will refuse.
    pairing.reset();

    console.log(`🔌 Connection closed (${statusCode ?? 'unknown'}). Reconnecting in ${reconnectDelay / 1000}s.`);
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, BACKOFF_MAX_MS);
    setTimeout(() => {
      if (!shuttingDown) start().catch(error => console.error('Reconnect failed:', error));
    }, delay);
  });

  // Needs the socket (group metadata, bot identity), so it is rebuilt per
  // connection - but the owner/whitelist sets come from config and the store.
  const protection = createProtection({
    socket,
    ownerNumbers: [config.OWNER_NUMBER].filter(Boolean),
    extraNumbers: config.PROTECTED_USERS,
    sudoStore: ownersStore,
    log: console.warn
  });

  const tools = {
    ...createMessageTools({
      socket,
      botName: config.BOT_NAME,
      prefix: config.PREFIX,
      mode: resolveMode(),
      settingsStore,
      ownersStore,
      globalStore,
      // One spam detector and one protection gate for the whole process, so no
      // two features can disagree about what counts as spam or who is exempt.
      spamManager,
      spamProtection: protection,
      debug
    }),
    menuImageUrl: config.MENU_IMAGE_URL,
    menuImagePath: config.MENU_IMAGE_PATH,
    menuTitle: config.MENU_TITLE,
    setMode(value) {
      tools.mode = value;
    }
  };

  socket.ev.on('call', async calls => {
    // handleCall logs each call individually (caller included); nothing to add here.
    await tools.handleCall(calls);
  });

  // Baileys publishes an explicit LID <-> phone-number pair when the server
  // sends one (lib/Socket/messages-recv.js:643). It is the cleanest source for
  // translating a LID target into the phone number the blocklist/group APIs need.
  socket.ev.on('chats.phoneNumberShare', ({ lid, jid } = {}) => {
    if (tools.learnLidPair({ lid, pn: jid })) console.log(`[lid] ${lid} -> ${jid}`);
  });

  socket.ev.on('group-participants.update', async event => {
    try {
      await tools.handleParticipants(event);
    } catch (error) {
      console.error('group-participants handler failed:', error?.message || error);
    }
  });

  // NOTE: `fromMe` messages ARE handled - see src/inbound.js. When the bot is
  // linked to your own number, every command you type from the phone arrives
  // with fromMe=true; the old blanket skip here is why commands looked dead.
  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: console.log
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const message of messages) {
      try {
        await handleInbound(message, type);
      } catch (error) {
        console.error('Message handler failed:', error?.message || error);
      }
    }
  });

  socket.ev.on('messages.update', async updates => {
    for (const { key, update } of updates) {
      if (update?.message === null) {
        try {
          await tools.restoreDeleted(key);
        } catch (error) {
          console.error('antidelete failed:', error?.message || error);
        }
      }
    }
  });

  return socket;
}

// Spam history lives in memory; sweep it so a long-running bot cannot leak.
// unref() keeps this from holding the process open on shutdown.
const sweepTimer = setInterval(() => {
  const { tracked } = spamManager.sweep();
  if (tracked > 0) console.log(`[spam] tracking ${tracked} active sender(s)`);
}, 60000);
sweepTimer.unref?.();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweepTimer);
  console.log(`\n${signal} received, closing the connection.`);
  try {
    currentSocket?.end(undefined);
  } catch {
    /* socket already gone */
  }
  setTimeout(() => process.exit(0), 300).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const warning of config.validate()) console.warn(`⚠️  ${warning}`);
console.log(`Starting ${config.BOT_NAME} (prefix "${config.PREFIX}", mode ${resolveMode()})...`);

start().catch(error => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});

module.exports = { start };
