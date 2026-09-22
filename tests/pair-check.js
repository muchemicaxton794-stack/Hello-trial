'use strict';

/**
 * Live pairing diagnostic: `npm run pair-check`
 *
 * Opens a throwaway socket against the real WhatsApp servers and proves the
 * linking handshake is reachable - i.e. that the QR code actually arrives. It
 * writes to a temporary session directory, so it never touches session/ or the
 * linked account.
 *
 * A QR is rendered so the handshake can be inspected by eye; scanning it links
 * a session that is deleted when this script exits, which is why the message
 * says to pair with `npm start` instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { createPairing } = require('../src/pairing');

const TIMEOUT_MS = Number(process.env.PAIR_CHECK_TIMEOUT_MS || 60000);

(async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hellotrial-pair-'));
  const qrFile = path.join(sessionDir, 'qr.txt');

  console.log('[pair-check] opening a test socket against WhatsApp...');

  const { state } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[pair-check] baileys ${version.join('.')}`);

  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ['Ubuntu', 'Chrome', '22.04.4']
  });

  const pairing = createPairing({
    socket,
    pairingNumber: process.env.PAIRING_NUMBER || '',
    botName: 'pair-check',
    qrFile,
    log: () => {},
    warn: message => console.warn(message)
  });

  const observations = { connecting: false, qr: false, open: false, closeCode: null, qrLength: 0, qrPayload: '' };

  await new Promise(resolve => {
    const timer = setTimeout(resolve, TIMEOUT_MS);

    socket.ev.on('connection.update', async update => {
      if (update.connection === 'connecting') observations.connecting = true;

      if (update.qr) {
        observations.qr = true;
        observations.qrLength = update.qr.length;
        observations.qrPayload = update.qr;
        qrcode.generate(update.qr, { small: true });
        console.log('[pair-check] scannable QR above (test session only, discarded on exit)');
        clearTimeout(timer);
        resolve();
      }

      if (update.connection === 'open') {
        observations.open = true;
        clearTimeout(timer);
        resolve();
      }

      if (update.connection === 'close') {
        observations.closeCode = update.lastDisconnect?.error?.output?.statusCode ?? null;
        clearTimeout(timer);
        resolve();
      }

      await pairing.handle(update).catch(() => {});
    });
  });

  try {
    socket.end(undefined);
  } catch {
    /* already closed */
  }

  const passed = observations.qr || observations.open;
  console.log('');
  console.log('[pair-check] result');
  console.log(`  reached "connecting" : ${observations.connecting}`);
  console.log(`  QR code delivered    : ${observations.qr}${observations.qr ? ` (${observations.qrLength} chars)` : ''}`);
  console.log(`  session opened       : ${observations.open}`);
  if (observations.closeCode !== null) console.log(`  close status code    : ${observations.closeCode}`);
  console.log(
    passed
      ? '  VERDICT: linkable - the pairing handshake works.'
      : '  VERDICT: no QR received. Check the network path to web.whatsapp.com and retry.'
  );
  console.log('');
  console.log('  To pair for real, run `npm start` (and scan the QR it prints).');

  // The QR payload is a credential-equivalent linking token: keep it out of the
  // repository and out of any log that might be shared.
  fs.rmSync(sessionDir, { recursive: true, force: true });

  process.exitCode = passed ? 0 : 1;
})().catch(error => {
  console.error('[pair-check] failed:', error?.message || error);
  process.exitCode = 1;
});
