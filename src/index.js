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

// Fixed WhatsApp/hosting identity: do not override this with an environment variable.
const CREATOR = 'bigbrother';
const BOT_NAME = 'bigbrother edition';
const PREFIX = process.env.PREFIX || '.';
const SESSION_DIR = path.join(process.cwd(), 'session');
let socket;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}
function cleanNumber(value) { return String(value || '').replace(/[^0-9]/g, ''); }
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
function printPairingBanner(code) {
  console.log('\n┌────────────────────────────────────────┐');
  console.log('│          bigbrother edition             │');
  console.log('│          Creator: bigbrother            │');
  console.log('├────────────────────────────────────────┤');
  console.log(`│  PAIRING CODE: ${String(code).padEnd(24)}│`);
  console.log('│  WhatsApp > Linked devices              │');
  console.log('│  > Link with phone number               │');
  console.log('└────────────────────────────────────────┘\n');
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
      try { printPairingBanner(await socket.requestPairingCode(await getPairingNumber())); }
      catch (error) { console.error('Could not create pairing code:', error.message); }
    }
    if (connection === 'open') console.log(`${BOT_NAME} connected successfully. Creator: ${CREATOR}`);
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(start, 3000);
  });
  const tools = createMessageTools({ socket, botName: BOT_NAME, prefix: PREFIX });
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue;
      try {
        await tools.remember(message);
        const parsed = tools.parseCommand(message);
        if (parsed) await runBigBroCommand({ ...tools, ...parsed, socket, BOT_NAME, PREFIX });
      } catch (error) { console.error('Message handler error:', error); await tools.reply(message, 'An internal error occurred while processing that command.'); }
    }
  });
  socket.ev.on('messages.update', async updates => { for (const { key, update } of updates) if (update.message === null) await tools.restoreDeleted(key); });
}
start().catch(error => { console.error('Fatal startup error:', error); process.exitCode = 1; });
