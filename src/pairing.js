'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

const MAX_CODE_ATTEMPTS = 3;

/**
 * Pairing manager.
 *
 * Baileys removed automatic terminal QR printing in 6.6: the `printQRInTerminal`
 * option is accepted but only emits a deprecation warning, so a bot that relies on
 * it (and never reads the `qr` field of connection.update) can never be paired.
 * This class owns the whole linking handshake instead:
 *
 *   - no PAIRING_NUMBER -> draw the QR in the terminal and mirror the raw string
 *     to data/qr.txt so headless hosts can render it elsewhere
 *   - PAIRING_NUMBER set -> request an 8-char pairing code exactly once per socket
 *
 * The once-guard matters: Baileys emits `qr` on every connection attempt and
 * requestPairingCode() mints a *new random code* each call, so an unguarded call
 * silently invalidates the code the user is typing in.
 */
function createPairing({
  socket,
  pairingNumber = '',
  pairingCode = '',
  botName = 'bot',
  qrFile,
  log = console.log,
  warn = console.warn
}) {
  let codeAttempts = 0; // failed attempts, capped
  let codeIssued = false; // a code is pending on the phone - never ask again
  let lastQr = '';
  let opened = false;

  function writeQrFile(qr) {
    try {
      fs.mkdirSync(path.dirname(qrFile), { recursive: true });
      fs.writeFileSync(qrFile, `${qr}\n`);
    } catch (error) {
      warn(`[pairing] could not write ${qrFile}: ${error.message}`);
    }
  }

  function clearQrFile() {
    try {
      fs.rmSync(qrFile, { force: true });
    } catch {
      /* not fatal */
    }
  }

  async function requestCode() {
    codeAttempts += 1;
    try {
      // A chosen code replaces Baileys' random one. WhatsApp requires exactly
      // 8 characters; config.validate() has already rejected anything else.
      const code = pairingCode
        ? await socket.requestPairingCode(pairingNumber, pairingCode)
        : await socket.requestPairingCode(pairingNumber);
      log('');
      log(`  ${botName} pairing code: ${code}${pairingCode ? '  (chosen via PAIRING_CODE)' : ''}`);
      log('  WhatsApp -> Settings -> Linked devices -> Link a device -> Link with phone number');
      log('');
      return code;
    } catch (error) {
      warn(`[pairing] pairing-code request ${codeAttempts}/${MAX_CODE_ATTEMPTS} failed: ${error?.message || error}`);
      if (codeAttempts >= MAX_CODE_ATTEMPTS) {
        warn(
          '[pairing] giving up on the pairing code. Remove PAIRING_NUMBER from .env and restart ' +
            'to link by QR code instead.'
        );
      }
      return null;
    }
  }

  return {
    /** True once this socket has completed the link handshake. */
    get opened() {
      return opened;
    },
    get codeIssued() {
      return codeIssued;
    },
    get codeAttempts() {
      return codeAttempts;
    },

    /**
     * Call on every disconnect, before reconnecting.
     *
     * A dropped connection voids the pending request server-side: the observed
     * path is a 408 (timedOut) followed by a 401 (loggedOut), and WhatsApp will
     * not honour the code that was issued against the dead attempt. Without this
     * reset, codeIssued stays true and the bot reconnects with a code that can
     * never be accepted - which is exactly how a pairing attempt becomes
     * unrecoverable without a restart.
     *
     * With a chosen PAIRING_CODE the re-minted code is identical, so nothing the
     * user is holding changes; with a random one a fresh code is the only useful
     * outcome, because the previous code is dead.
     */
    reset() {
      codeAttempts = 0;
      codeIssued = false;
      lastQr = '';
    },

    /**
     * Feed every connection.update payload here.
     * Returns 'code' | 'qr' | 'open' | 'idle' for the caller/logging.
     */
    async handle(update = {}) {
      const { connection, qr, isNewLogin } = update;

      if (qr) {
        if (pairingNumber) {
          // Once a code has been issued it stays valid until the phone uses it,
          // so asking again would only overwrite it. Retry solely after a failure.
          if (codeIssued || codeAttempts >= MAX_CODE_ATTEMPTS) return 'idle';
          const code = await requestCode();
          if (code) {
            codeIssued = true;
            return 'code';
          }
          return 'idle';
        }

        if (qr !== lastQr) {
          lastQr = qr;
          if (process.stdout.isTTY) {
            log('');
            log(`  Scan this QR code with ${botName} (WhatsApp -> Linked devices):`);
            qrcode.generate(qr, { small: true });
            log('');
          } else {
            log(`[pairing] QR code received. Raw payload saved to ${qrFile}`);
          }
          writeQrFile(qr);
        }
        return 'qr';
      }

      if (connection === 'open') {
        opened = true;
        clearQrFile();
        log(`[pairing] linked${isNewLogin ? ' (new login)' : ''}.`);
        return 'open';
      }

      return 'idle';
    }
  };
}

module.exports = { createPairing, MAX_CODE_ATTEMPTS };
