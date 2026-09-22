'use strict';

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

/** Sent to the paired number the moment a new device is linked. */
const DEFAULT_PAIR_WELCOME =
  'your bot have been paired welcome to darknote L2 by bigbrother where we change your dream to reality';

const MAX_ATTEMPTS = 3;

function pairWelcomeText(custom) {
  const text = String(custom ?? '').trim();
  return text || DEFAULT_PAIR_WELCOME;
}

/**
 * Notes that a fresh device was just linked.
 *
 * The flag is persisted rather than kept in memory because Baileys raises
 * `isNewLogin` *before* the server-requested restart: the welcome can only be
 * sent once the socket comes back up, which is a separate connection. Persisting
 * it means a crash in between still delivers the welcome on the next boot.
 */
function markPairWelcomePending(globalStore) {
  globalStore.set('pairWelcomePending', true);
  globalStore.set('pairWelcomeAttempts', 0);
}

/**
 * Sends the welcome DM to the paired number (its own "Message yourself" chat)
 * and clears the pending flag. Pass `force: true` to send outside the pairing
 * flow, e.g. from scripts/send-welcome.js.
 *
 * Returns { sent, jid?, reason? } - never throws.
 */
async function deliverPairWelcome({
  socket,
  globalStore,
  text,
  force = false,
  log = console.log,
  warn = console.warn
}) {
  if (!force && !globalStore.get('pairWelcomePending')) {
    return { sent: false, reason: 'no pairing welcome is pending' };
  }

  const me = socket.user?.id;
  if (!me) {
    // Identity is not populated yet; leave the flag set so the next 'open' retries.
    return { sent: false, reason: 'socket has no identity yet' };
  }

  const jid = jidNormalizedUser(me);

  try {
    await socket.sendMessage(jid, { text: pairWelcomeText(text) });
    if (!force) globalStore.set('pairWelcomePending', false);
    globalStore.set('pairWelcomeSentAt', new Date().toISOString());
    globalStore.set('pairWelcomeSentTo', jid);
    log(`👋 pairing welcome sent to ${jid}`);
    return { sent: true, jid };
  } catch (error) {
    const message = error?.message || String(error);
    const attempts = (globalStore.get('pairWelcomeAttempts') || 0) + 1;

    if (attempts >= MAX_ATTEMPTS) {
      globalStore.set('pairWelcomePending', false);
      globalStore.set('pairWelcomeAttempts', 0);
      warn(`[welcome] giving up after ${attempts} attempts: ${message}`);
    } else {
      globalStore.set('pairWelcomeAttempts', attempts);
      warn(`[welcome] attempt ${attempts}/${MAX_ATTEMPTS} failed: ${message}`);
    }

    return { sent: false, jid, reason: message };
  }
}

module.exports = { DEFAULT_PAIR_WELCOME, pairWelcomeText, markPairWelcomePending, deliverPairWelcome, MAX_ATTEMPTS };
