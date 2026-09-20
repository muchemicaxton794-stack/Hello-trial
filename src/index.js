require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const P = require('pino');
const readline = require('readline');
const path = require('path');
const { runBigBroCommand } = require('./bigbro');
const { createMessageTools } = require('./msg');
const CREATOR = 'bigbrother';
const BOT_NAME = process.env.BOT_NAME || 'bigbrother edition';
const PREFIX = process.env.PREFIX || '.';
const SESSION_DIR = path.join(process.cwd(), 'session');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer);
  }));
}

function cleanNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

async function getPairingNumber() {
  const envNumber = cleanNumber(process.env.PAIRING_NUMBER);
  if (envNumber && envNumber.length >= 8) return envNumber;
  return null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    logger: P({ level: 'silent' }),
    printQRInTerminal: true
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting' && !state.creds.registered) {
      const pairingNumber = await getPairingNumber();
      if (pairingNumber) {
        try {
          const code = await socket.requestPairingCode(pairingNumber);
          console.log(`${BOT_NAME} pairing code: ${code}`);
        } catch (error) {
          console.error('Pairing setup failed:', error.message || error);
        }
      } else {
        console.log(`${BOT_NAME} waiting for QR scan from a linked device.`);
      }
    }

    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      setTimeout(start, 3000);
    }
  });

  const tools = createMessageTools({ socket, botName: BOT_NAME, prefix: PREFIX });
  socket.ev.on('call', async calls => {
    for (const call of calls) {
      if (tools.settings.global?.anticall && call.from) {
        try {
          await socket.rejectCall(call.id, call.from);
        } catch (error) {
          console.error('rejectCall failed:', error.message || error);
        }
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue;
      try {
        await tools.remember(message);
        if (await tools.handleProtection(message)) continue;
        const parsed = tools.parseCommand(message);
        if (!parsed) continue;
        const output = await runBigBroCommand({ ...parsed, ...tools });
        if (output) await output;
      } catch (error) {
        console.error('Message handler failed:', error.message || error);
      }
    }
  });

  socket.ev.on('messages.update', async updates => {
    for (const { key, update } of updates) {
      if (update.message === null) await tools.restoreDeleted(key);
    }
  });
}

start().catch(error => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});
