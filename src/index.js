require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const P = require('pino');
const readline = require('readline');
const path = require('path');
const { runBigBroCommand } = require('./bigbro');
const { createMessageTools } = require('./msg');

const BOT_NAME = process.env.BOT_NAME || 'DARKNOTE Lv2';
const PREFIX = process.env.PREFIX || '.';
const SESSION_DIR = path.join(process.cwd(), 'session');
let socket;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

function cleanNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

async function getPairingNumber() {
  const configured = cleanNumber(process.env.PAIRING_NUMBER);
  if (configured) return configured;
  let number = '';
  while (!number || number.length < 8) {
    number = cleanNumber(await ask('Enter your WhatsApp number with country code (example: 233XXXXXXXXX): '));
    if (number.length < 8) console.log('Please enter a valid international number without +, spaces, or dashes.');
  }
  return number;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: [BOT_NAME, 'Chrome', '1.0.0']
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting' && !state.creds.registered) {
      try {
        const number = await getPairingNumber();
        const code = await socket.requestPairingCode(number);
        console.log(`\n${BOT_NAME} PAIRING CODE: ${code}\nEnter it in WhatsApp > Linked devices > Link with phone number.\n`);
      } catch (error) {
        console.error('Could not create pairing code:', error.message);
      }
    }
    if (connection === 'open') console.log(`${BOT_NAME} connected successfully.`);
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      console.log('Connection closed. Reconnecting...');
      setTimeout(start, 3000);
    }
  });

  const tools = createMessageTools({ socket, botName: BOT_NAME, prefix: PREFIX });
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue;
      try {
        await tools.remember(message);
        const parsed = tools.parseCommand(message);
        if (!parsed) continue;
        await runBigBroCommand({ ...tools, ...parsed, socket, BOT_NAME, PREFIX });
      } catch (error) {
        console.error('Message handler error:', error);
        await tools.reply(message, 'An internal error occurred while processing that command.');
      }
    }
  });

  socket.ev.on('messages.update', async updates => {
    for (const { key, update } of updates) {
      if (update.message === null) await tools.restoreDeleted(key);
    }
  });
}

start().catch(error => { console.error('Fatal startup error:', error); process.exitCode = 1; });
