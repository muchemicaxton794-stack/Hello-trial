'use strict';

/**
 * Inbound message pipeline for `messages.upsert`.
 *
 * Three rules matter here, and getting any of them wrong makes the bot look
 * broken in a different way.
 *
 * 1. `fromMe` messages MUST be processed. When the bot is linked to your own
 *    number, everything you type from your phone comes back with
 *    `fromMe: true`. The original code skipped those
 *    (`if (... || message.key.fromMe) continue`), so no command ever ran.
 *
 *    The loop hazard is handled the other way round: ids of messages this
 *    process sent are recorded and dropped on the way back in, which also makes
 *    a reply whose text starts with the prefix harmless.
 *
 * 2. The upsert `type` cannot be used to detect replays. Baileys labels a live
 *    message `'append'` whenever the notification node carries an `offline`
 *    attribute (`lib/Socket/messages-recv.js:699`) - and messages synced back
 *    from your own account carry exactly that. Trusting the type swallows real
 *    commands. Age is the reliable signal: history sync replays old messages
 *    with their original timestamps, so anything older than
 *    COMMAND_MAX_AGE_SECONDS is treated as a replay and not dispatched.
 *
 * 3. Anything fresh enough to act on is still remembered for antidelete, and
 *    group protection runs before command dispatch so a message that was just
 *    deleted cannot also run a command.
 */

/** Chats that are not conversations and cannot be commanded. */
const { previewText } = require('./redact');

const IGNORED_CHATS = new Set(['status@broadcast']);
const IGNORED_SUFFIXES = ['@newsletter', '@broadcast'];

const HIDE_MESSAGE_TEXT = String(process.env.LOG_MESSAGE_TEXT || 'true').toLowerCase() === 'false';

function isIgnoredChat(jid = '') {
  return IGNORED_CHATS.has(jid) || IGNORED_SUFFIXES.some(suffix => jid.endsWith(suffix));
}

/** Commands older than this are treated as history replay, not as input. */
const COMMAND_MAX_AGE_SECONDS = Number(process.env.COMMAND_MAX_AGE_SECONDS || 30 * 60);

function timestampOf(message) {
  const raw = message?.messageTimestamp;
  if (raw === null || raw === undefined) return null;
  // Longs from protobuf, plain numbers, and numeric strings all turn up here.
  const value = typeof raw === 'object' && typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function ageSeconds(message, now = Date.now()) {
  const stamp = timestampOf(message);
  if (stamp === null) return null;
  return now / 1000 - stamp;
}

function createInboundHandler({ tools, dispatch, log = console.log, maxAgeSeconds = COMMAND_MAX_AGE_SECONDS }) {
  return async function handleInbound(message, type = 'notify') {
    if (!message?.message) return 'skipped';

    const jid = message.key?.remoteJid || '';
    if (!jid || isIgnoredChat(jid)) return 'skipped';

    const fromMe = Boolean(message.key?.fromMe);

    // Our own output must never re-enter the dispatcher.
    if (fromMe && tools.wasSelfSent(message.key.id)) return 'self-sent';

    // Feed antidelete before any other decision.
    await tools.remember(message);

    const text = tools.textOf(message);
    const age = ageSeconds(message);
    // When WhatsApp includes both identifiers, show them: this is the pair that
    // lets a LID target be translated into the phone number the APIs demand.
    const pair = [
      message.key?.participantLid ? `lid=${message.key.participantLid}` : null,
      message.key?.participantPn ? `pn=${message.key.participantPn}` : null
    ]
      .filter(Boolean)
      .join(' ');

    const shown = previewText(text.slice(0, 80), { hideText: HIDE_MESSAGE_TEXT });

    log(
      `[in] ${tools.isGroup(jid) ? 'group' : 'dm'} ${jid} fromMe=${fromMe} type=${type}` +
        `${age === null ? '' : ` age=${Math.round(age)}s`}${pair ? ` ${pair}` : ''} ` +
        `${shown ? JSON.stringify(shown) : '[media]'}`
    );

    if (await tools.handleProtection(message)) {
      log('[in] deleted by group protection');
      return 'protected';
    }

    const parsed = tools.parseCommand(message);
    if (!parsed) return 'ignored';

    const stale = age !== null && age > maxAgeSeconds;
    if (stale) {
      log(`[in] ignoring .${parsed.command}: replayed history (${Math.round(age / 60)} min old)`);
      return 'replay';
    }

    log(`[in] command .${parsed.command} from ${message.key.participant || message.key.remoteJid}`);
    const output = await dispatch(parsed);
    if (output) await output;
    return 'command';
  };
}

module.exports = {
  createInboundHandler,
  IGNORED_CHATS,
  IGNORED_SUFFIXES,
  isIgnoredChat,
  COMMAND_MAX_AGE_SECONDS,
  timestampOf,
  ageSeconds
};
