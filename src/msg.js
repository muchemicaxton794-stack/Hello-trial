'use strict';

const P = require('pino');
const { downloadMediaMessage, jidNormalizedUser, getContentType } = require('@whiskeysockets/baileys');
const { redact } = require('./redact');

const silentLogger = P({ level: 'silent' });

/**
 * Settings every group starts with.
 *
 * `antimessage` replaces the older `antimsg`; migrateSettings() carries the old
 * value over so an existing group does not silently lose its protection.
 */
const GROUP_DEFAULTS = {
  antilink: false,
  gclink: false,
  antidelete: false,
  antisticker: false,
  antimessage: false,
  antibot: false,
  autoblock: false,
  antikick: false,
  welcome: false,
  goodbye: false
};

/** Renamed keys, applied once when a group's settings are first read. */
const RENAMED_SETTINGS = { antimsg: 'antimessage' };

function migrateSettings(entry) {
  let changed = false;
  for (const [oldKey, newKey] of Object.entries(RENAMED_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(entry, oldKey)) {
      if (entry[newKey] === undefined) entry[newKey] = entry[oldKey];
      delete entry[oldKey];
      changed = true;
    }
  }
  return changed;
}

/**
 * "Sent from a web-based client" message ids.
 *
 * WhatsApp Web/Desktop and Baileys both mint ids beginning with 3EB0, so this is
 * a blunt signal: with `antibot` on, an ordinary member using WhatsApp Web gets
 * deleted too. Group admins and owners are exempt from auto-moderation, which is
 * what keeps the false positives tolerable in practice.
 */
const BOT_ID_PREFIXES = ['3EB0'];

const ANTI_DELETE_TTL_MS = 10 * 60 * 1000;
const ANTI_DELETE_CAP = 2000;

function numberOf(jid = '') {
  return String(jid).split('@')[0].split(':')[0];
}

function baseJid(jid = '') {
  try {
    return jidNormalizedUser(jid) || numberOf(jid);
  } catch {
    return numberOf(jid);
  }
}

function sameUser(a, b) {
  if (!a || !b) return false;
  return baseJid(a) === baseJid(b) || numberOf(a) === numberOf(b);
}

function isGroup(jid = '') {
  return String(jid).endsWith('@g.us');
}

function mention(jid) {
  return `@${numberOf(jid)}`;
}

function formatRuntime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h ${Math.floor((total % 3600) / 60)}m ${total % 60}s`;
}

function unwrap(message) {
  const body = message?.message;
  return body?.ephemeralMessage?.message || body?.viewOnceMessage?.message || body?.viewOnceMessageV2?.message || body;
}

function textOf(message) {
  const body = unwrap(message);
  if (!body) return '';
  return (
    body.conversation ||
    body.extendedTextMessage?.text ||
    body.imageMessage?.caption ||
    body.videoMessage?.caption ||
    body.documentMessage?.caption ||
    ''
  );
}

/** Content kind of a message, or null when it carries no media. */
function mediaTypeOf(message) {
  const body = unwrap(message);
  if (!body) return null;
  try {
    return getContentType(body) || null;
  } catch {
    return null;
  }
}

function isSticker(message) {
  return mediaTypeOf(message) === 'stickerMessage';
}

/**
 * Content keys that carry downloadable media. mediaTypeOf() returns any single
 * content key (including "conversation"), so it cannot be used on its own to
 * decide whether a message has media - that distinction is what made the old
 * `.sticker` path try to download a text message.
 */
const MEDIA_KEYS = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'documentWithCaptionMessage',
  'stickerMessage',
  'ptvMessage'
]);

function mediaKeyOf(message) {
  const key = mediaTypeOf(message);
  return key && MEDIA_KEYS.has(key) ? key : null;
}

function isMediaMessage(message) {
  return Boolean(mediaKeyOf(message));
}

/** Only these can be turned into a sticker. */
function isStickerSource(message) {
  const key = mediaKeyOf(message);
  return key === 'imageMessage' || key === 'videoMessage' || key === 'stickerMessage';
}

function mentionedJids(message) {
  return unwrap(message)?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function contextInfoOf(message) {
  const body = unwrap(message);
  if (body?.extendedTextMessage?.contextInfo) return body.extendedTextMessage.contextInfo;
  for (const value of Object.values(body || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

function quotedParticipant(message) {
  return contextInfoOf(message)?.participant;
}

/**
 * One-line summary of an outgoing message for the console: the first line of
 * the text (with a note when more lines follow), or the kind of media sent.
 */
function describeOutgoing(jid, content, maxLength = 80) {
  const chat = `${isGroup(jid) ? 'group' : 'dm'} ${jid}`;
  if (!content || typeof content !== 'object') return `${chat} [unknown content]`;

  const text = typeof content.text === 'string' ? content.text : content.caption;
  if (typeof text === 'string' && text.length) {
    const lines = text.split('\n');
    // Scrubbed before it reaches the log file: replies can echo secrets back.
    const preview = redact(lines[0].slice(0, maxLength));
    const rest = lines.length > 1 ? ` …(+${lines.length - 1} lines)` : '';
    return `${chat} ${JSON.stringify(preview)}${rest}`;
  }

  for (const kind of ['image', 'video', 'audio', 'sticker', 'document', 'forward']) {
    if (content[kind]) return `${chat} [${kind}]`;
  }
  if (content.delete) return `${chat} [delete]`;
  return `${chat} [content]`;
}

function groupLinkOf(text) {
  return /https?:\/\/(chat\.whatsapp\.com|whatsapp\.com\/channel|wa\.me\/)/i.test(String(text || ''));
}

function anyLinkOf(text) {
  return /https?:\/\/\S+/i.test(String(text || ''));
}

/**
 * Builds the tool bag handed to the command dispatcher, plus the group safety
 * middleware. Everything the dispatcher needs is injected here so the dispatcher
 * itself stays testable with a fake socket.
 */
function createMessageTools({
  socket,
  botName,
  prefix,
  mode = 'self',
  settingsStore,
  ownersStore,
  globalStore,
  spamManager = null,
  spamProtection = null,
  debug = null,
  log = console.log,
  warn = console.warn,
  startedAt = Date.now()
}) {
  // Both are injected so the middleware cannot silently degrade to "no manager":
  // a null here would mean spam detection is off, which must be explicit.
  const fallbackDebug = { log: () => {}, run: async (entry, operation) => ({ ok: true, value: await operation() }) };
  const debugLog = debug || fallbackDebug;

  // -- LID <-> phone-number directory -------------------------------------
  // Blocking and group updates address people by phone number, but chats are
  // increasingly addressed by LID instead, and handing a LID to those APIs comes
  // back as a bare "bad-request" with no explanation. WhatsApp tells us the pairs
  // (message keys carry participantLid/participantPn, participant entries carry
  // id/lid), so learn them and translate before calling.
  const lidToPn = new Map();

  /** Returns true when the pair was not already known. */
  function learnLidPair(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    // Message keys carry senderLid/senderPn (DMs included) and
    // participantLid/participantPn (groups); participant entries carry id/lid.
    const lid = candidate.participantLid || candidate.senderLid || candidate.lid;
    if (!lid) return false;

    const sources = [candidate.participantPn, candidate.senderPn, candidate.pn, candidate.phoneNumber];
    if (typeof candidate.id === 'string' && candidate.id.includes('@') && !candidate.id.endsWith('@lid')) {
      sources.push(candidate.id);
    }

    const pn = sources.find(value => typeof value === 'string' && value.includes('@') && !value.endsWith('@lid'));
    if (!pn) return false;

    const lidBase = baseJid(lid);
    const pnBase = baseJid(pn);
    if (!lidBase.endsWith('@lid') || lidToPn.get(lidBase) === pnBase) return false;

    lidToPn.set(lidBase, pnBase);
    return true;
  }

  function learnFromMetadata(meta) {
    for (const participant of meta?.participants || []) learnLidPair(participant);
  }

  /** Phone-number JID for a user, or null when only a LID is known. */
  function toPhoneJid(jid) {
    if (!jid) return null;
    const base = baseJid(jid);
    if (!base.endsWith('@lid')) return base;
    return lidToPn.get(base) || null;
  }

  // -- ids of messages this process sent ---------------------------------
  // `fromMe` messages are processed (that is how the linked account's own
  // commands arrive), so the bot has to be able to tell its own output apart
  // from the owner's input. Replies are recorded here and dropped on the way
  // back in, which also makes a reply that starts with the prefix harmless.
  const selfSentIds = new Set();
  const SELF_SENT_CAP = 500;

  function trackSelfSent(id) {
    if (!id) return;
    selfSentIds.add(id);
    if (selfSentIds.size > SELF_SENT_CAP) {
      const oldest = selfSentIds.values().next();
      if (!oldest.done) selfSentIds.delete(oldest.value);
    }
  }

  if (socket && !socket.__helloTrialSendTracked) {
    const originalSend = socket.sendMessage.bind(socket);
    socket.sendMessage = async (...args) => {
      const result = await originalSend(...args);
      trackSelfSent(result?.key?.id);
      // Log every send. Without this the console only ever showed one half of the
      // conversation, and "did my command get a reply?" was unanswerable.
      log(`[out] ${describeOutgoing(args[0], args[1])}`);
      return result;
    };
    socket.__helloTrialSendTracked = true;
  }

  // -- deleted-message cache (antidelete) --------------------------------
  const deletedMessages = new Map();

  function remember(message) {
    // Every incoming message is a chance to learn a LID -> phone-number pair.
    if (learnLidPair(message?.key)) {
      log(`[lid] learned ${message.key.participantLid || message.key.senderLid} -> ${message.key.participantPn || message.key.senderPn}`);
    }
    const id = message?.key?.id;
    if (!id) return;
    deletedMessages.set(id, message);
    if (deletedMessages.size > ANTI_DELETE_CAP) {
      const oldest = deletedMessages.keys().next();
      if (!oldest.done) deletedMessages.delete(oldest.value);
    }
    setTimeout(() => deletedMessages.delete(id), ANTI_DELETE_TTL_MS).unref?.();
  }

  // Flood tracking used to live here as its own sliding window. It has moved to
  // the single SpamManager (src/spam.js) so AntiMessage and AutoBlock cannot
  // disagree about what counts as spam, and only one place sweeps expired state.

  // -- removals the bot itself requested (so antikick does not undo them) --
  const expectedRemovals = new Map();

  function expectRemoval(jid, jids) {
    const set = expectedRemovals.get(jid) || new Set();
    for (const jidOfUser of jids) set.add(baseJid(jidOfUser));
    expectedRemovals.set(jid, set);
    setTimeout(() => expectedRemovals.delete(jid), 60000).unref?.();
  }

  function ownerSet() {
    const extra = ownersStore ? ownersStore.get('owners') || [] : [];
    return new Set([...(Array.isArray(extra) ? extra : [])].map(value => String(value).split('@')[0].split(':')[0]));
  }

  /**
   * The paired account is always an owner. It is checked under both identifiers:
   * a chat can address the account by its LID ("252119428927664@lid") rather than
   * its phone number, and matching only the number means the owner's own commands
   * are refused in those chats.
   */
  function isOwner(user) {
    if (!user) return false;
    if (socket.user?.id && sameUser(socket.user.id, user)) return true;
    if (socket.user?.lid && sameUser(socket.user.lid, user)) return true;
    return ownerSet().has(numberOf(user));
  }

  function botJid() {
    const me = socket.user?.id;
    return me ? baseJid(me) : null;
  }

  async function groupMeta(jid) {
    return socket.groupMetadata(jid);
  }

  /**
   * Finds a participant entry by id or LID. Comparing the bare number keeps this
   * working when the JID carries a device suffix ("1234:5@s.whatsapp.net"), which
   * is what made the old `.kickall` self-exclusion unreliable.
   */
  function findParticipant(participants, user) {
    return (participants || []).find(
      participant =>
        sameUser(participant.id, user) ||
        (participant.lid && sameUser(participant.lid, user)) ||
        (participant.phoneNumber && sameUser(participant.phoneNumber, user))
    );
  }

  async function adminFlag(jid, user) {
    if (!jid || !user || !isGroup(jid)) return false;
    try {
      const meta = await groupMeta(jid);
      learnFromMetadata(meta); // group metadata is the richest source of LID pairs
      return Boolean(findParticipant(meta?.participants, user)?.admin);
    } catch (error) {
      warn(`[tools] groupMetadata failed for ${jid}: ${error?.message || error}`);
      return false;
    }
  }

  async function isGroupAdmin(jid, user) {
    return adminFlag(jid, user);
  }

  /**
   * Checks both the phone-number JID and the LID: groups can address a member by
   * either, and matching only the PN silently reports "not an admin" in
   * LID-addressed groups, which disables every admin command.
   */
  async function botIsAdmin(jid) {
    const candidates = [socket.user?.id, socket.user?.lid].filter(Boolean);
    for (const candidate of candidates) {
      if (await adminFlag(jid, candidate)) return true;
    }
    return false;
  }

  function isPrivileged(jid, user) {
    if (isOwner(user)) return Promise.resolve(true);
    return isGroupAdmin(jid, user);
  }

  function groupSettings(jid) {
    const entry = settingsStore.get(jid);
    // One-time rename, so a group configured before the AntiMessage rename keeps
    // its protection instead of quietly reverting to off.
    if (migrateSettings(entry)) settingsStore.save();
    return entry;
  }

  function saveSettings() {
    settingsStore.save();
  }

  function resetSettings(jid) {
    settingsStore.delete(jid);
    return groupSettings(jid);
  }

  function targetUsers(message) {
    const users = [...new Set([...mentionedJids(message), quotedParticipant(message)].filter(Boolean))];
    return users.filter(user => !sameUser(user, socket.user?.id));
  }

  function reply(message, text, extra = {}) {
    return socket.sendMessage(message.key.remoteJid, { text, ...extra }, { quoted: message });
  }

  function send(jid, content, extra = {}) {
    return socket.sendMessage(jid, content, extra);
  }

  function parseCommand(message) {
    const text = textOf(message).trim();
    if (!text.startsWith(prefix)) return null;
    const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const [raw, ...args] = parts;
    return { command: raw.toLowerCase(), args, jid: message.key.remoteJid, message };
  }

  function defaultDownloadMedia(message) {
    return downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: silentLogger,
        reuploadRequest: typeof socket.updateMediaMessage === 'function' ? socket.updateMediaMessage : async msg => msg
      }
    );
  }

  const tools = {
    socket,
    botName,
    prefix,
    mode,
    startedAt,
    settingsStore,
    ownersStore,
    globalStore,
    spamManager,
    spamProtection,
    debug: debugLog,
    log,
    warn,
    textOf,
    mediaTypeOf,
    mediaKeyOf,
    isMediaMessage,
    isStickerSource,
    isSticker,
    isGroup,
    mention,
    numberOf,
    baseJid,
    sameUser,
    formatRuntime,
    groupSettings,
    saveSettings,
    resetSettings,
    groupMeta,
    isGroupAdmin,
    isOwner,
    isPrivileged,
    botIsAdmin,
    botJid,
    targetUsers,
    reply,
    send,
    parseCommand,
    remember,
    expectRemoval,
    toPhoneJid,
    learnLidPair,
    lidPairCount: () => lidToPn.size,
    wasSelfSent: id => Boolean(id) && selfSentIds.has(id),
    downloadMedia: defaultDownloadMedia
  };

  // ---------------------------------------------------------------------
  // antidelete: replay what was removed
  // ---------------------------------------------------------------------
  tools.restoreDeleted = async key => {
    if (!key?.id || !key.remoteJid) return false;
    const original = deletedMessages.get(key.id);
    if (!original) return false;
    deletedMessages.delete(key.id);
    if (!isGroup(key.remoteJid)) return false;
    if (!groupSettings(key.remoteJid).antidelete) return false;

    const author = original.key?.participant || quotedParticipant(original);
    const notice = `🗑️ Deleted message${author ? ` from ${mention(author)}` : ''}:`;
    const text = textOf(original);
    const mediaKey = mediaKeyOf(original);

    try {
      if (mediaKey) {
        await send(key.remoteJid, { text: `${notice} [${mediaKey.replace(/Message$/, '')}]`, mentions: author ? [author] : [] });
        await send(key.remoteJid, { forward: original, force: true });
      } else {
        await send(key.remoteJid, { text: `${notice}\n${text || '[empty]'}`, mentions: author ? [author] : [] });
      }
      return true;
    } catch (error) {
      warn(`[antidelete] could not replay ${key.id}: ${error?.message || error}`);
      try {
        await send(key.remoteJid, { text: `${notice} [media unavailable]`, mentions: author ? [author] : [] });
      } catch {
        /* give up silently */
      }
      return false;
    }
  };

  // ---------------------------------------------------------------------
  // Group protection middleware. Returns true when it acted, so the caller
  // skips command dispatch for a message that was just deleted.
  // ---------------------------------------------------------------------
  tools.handleProtection = async message => {
    const jid = message?.key?.remoteJid;
    if (!jid || !isGroup(jid) || message.key.fromMe) return false;

    const sender = message.key.participant;
    if (!sender) return false;
    if (sameUser(sender, socket.user?.id)) return false;

    // Owners and admins are never auto-moderated.
    if (isOwner(sender)) return false;
    if (await isGroupAdmin(jid, sender)) return false;

    // §5/§35: protected users are exempt from every automatic action, including
    // deletion. The reason is logged rather than silently skipping, so a group
    // owner wondering why nothing happens can see why.
    if (spamProtection) {
      const verdict = await spamProtection.check(sender, { chatJid: jid }).catch(() => ({ protected: false, reason: null }));
      if (verdict.protected) {
        debug.log({ feature: 'Protection', chat: jid, sender, action: 'skip', reason: verdict.reason, result: 'SKIPPED' });
        return false;
      }
    }

    const config = groupSettings(jid);
    const text = textOf(message);

    const drop = async () => {
      try {
        await send(jid, { delete: message.key });
        return true;
      } catch (error) {
        warn(`[protection] delete failed in ${jid}: ${error?.message || error}`);
        return false;
      }
    };

    if (config.antibot && BOT_ID_PREFIXES.some(prefixOfId => String(message.key.id || '').startsWith(prefixOfId))) {
      debug.log({ feature: 'AntiBot', chat: jid, sender, action: 'delete', result: 'SUCCESS' });
      return drop();
    }

    if (config.antilink && anyLinkOf(text)) {
      debug.log({ feature: 'AntiLink', chat: jid, sender, action: 'delete', result: 'SUCCESS' });
      return drop();
    }

    if (config.gclink && groupLinkOf(text)) {
      debug.log({ feature: 'AntiGroupLink', chat: jid, sender, action: 'delete', result: 'SUCCESS' });
      return drop();
    }

    // §9: stickers only. isSticker() is keyed on stickerMessage, so images,
    // videos, GIFs (videoMessage with gifPlayback) and documents are untouched.
    if (config.antisticker && isSticker(message)) {
      return handleSpamPunishment({ jid, sender, feature: 'AntiSticker', deleted: await drop() });
    }

    if (!text) return false;

    // §6/§7: one detector, shared by AntiMessage and AutoBlock. Ran even when
    // antiMessage is off so AutoBlock still sees the traffic pattern.
    const verdict = spamManager
      ? spamManager.record(jid, sender, text)
      : { spam: false, reason: null, count: 0 };

    if (config.antimessage && verdict.spam) {
      const deleted = await drop();
      debug.log({ feature: 'AntiMessage', chat: jid, sender, action: 'delete', reason: verdict.reason, result: deleted ? 'SUCCESS' : 'FAILED' });
      return handleSpamPunishment({ jid, sender, feature: 'AntiMessage', deleted, reason: verdict.reason });
    }

    // AutoBlock is the escalation path: it needs a real threshold, never one
    // suspicious message, and never a repeat punishment for the same burst.
    if (config.autoblock && verdict.spam && spamManager && !spamManager.wasPunishedRecently(jid, sender)) {
      const deleted = await drop();
      return handleSpamPunishment({ jid, sender, feature: 'AutoBlock', deleted, reason: verdict.reason, forceBlock: true });
    }

    return false;
  };

  /**
   * §7: applies the configured action set (delete/warn/kick/block) and records
   * what actually happened. Each step is reported on its own result, so a failed
   * kick is never described as a successful punishment.
   */
  async function handleSpamPunishment({ jid, sender, feature, deleted, reason = null, forceBlock = false }) {
    const actions = forceBlock ? [...new Set([...spamManager.actions, 'block'])] : spamManager.actions;

    if (actions.includes('warn')) {
      const next = spamManager.nextWarning(jid, sender);
      if (next.issue) {
        spamManager.noteWarning(jid, sender);
        const text = `⚠️ ${mention(sender)} that looks like spam (${reason || 'flood'}). Warning ${next.used}/${spamManager.messageLimit ? spamManager.warnLimit : '?'}.`;
        const sent = await send(jid, { text, mentions: [sender] }).then(() => true).catch(() => false);
        debug.log({ feature: `${feature}/warn`, chat: jid, sender, target: sender, action: 'warn', reason, result: sent ? 'SUCCESS' : 'FAILED' });
      }
    }

    if (actions.includes('kick') && !spamManager.wasPunishedRecently(jid, sender)) {
      const target = toPhoneJid(sender);
      if (!target) {
        warn(`[${feature}] cannot kick ${sender}: only a LID is known`);
        await send(jid, { text: `⚠️ ${mention(sender)}: no phone number known, cannot remove.`, mentions: [sender] }).catch(() => {});
      } else {
        await debug.run(
          { feature: `${feature}/kick`, chat: jid, sender, target, action: 'kick', reason },
          () => socket.groupParticipantsUpdate(jid, [target], 'remove')
        );
      }
    }

    if ((actions.includes('block') || forceBlock) && !spamManager.wasPunishedRecently(jid, sender)) {
      const target = toPhoneJid(sender);
      if (!target) {
        warn(`[${feature}] cannot block ${sender}: only a LID is known`);
      } else {
        const outcome = await debug.run(
          { feature: `${feature}/block`, chat: jid, sender, target, action: 'block', reason },
          () => socket.updateBlockStatus(target, 'block')
        );
        if (outcome.ok) spamManager.notePunished(jid, sender);
      }
    }

    if (actions.includes('kick') || actions.includes('block')) spamManager.notePunished(jid, sender);

    return Boolean(deleted) || actions.length > 0;
  }

  // ---------------------------------------------------------------------
  // group-participants.update: antikick, welcome, goodbye
  // ---------------------------------------------------------------------
  tools.handleParticipants = async event => {
    const jid = event?.id;
    if (!jid || !isGroup(jid)) return;
    const config = groupSettings(jid);
    const participants = Array.isArray(event.participants) ? event.participants : [];
    if (!participants.length) return;

    if (event.action === 'add' && config.welcome) {
      for (const user of participants) {
        if (sameUser(user, socket.user?.id)) continue;
        try {
          await send(jid, {
            text: `👋 Welcome ${mention(user)} to *${(await groupMeta(jid).catch(() => null))?.subject || 'the group'}*!\nMention an admin if you need help.`,
            mentions: [user]
          });
        } catch (error) {
          warn(`[welcome] ${error?.message || error}`);
        }
      }
    }

    if (event.action === 'remove' && config.goodbye) {
      for (const user of participants) {
        if (sameUser(user, socket.user?.id)) continue;
        try {
          await send(jid, { text: `👋 ${mention(user)} left the group.`, mentions: [user] });
        } catch (error) {
          warn(`[goodbye] ${error?.message || error}`);
        }
      }
    }

    if (event.action === 'remove' && config.antikick) {
      const selfJid = socket.user?.id;
      // Never fight the bot's own removals, and never try to re-add the bot.
      if (sameUser(event.author, selfJid)) return;
      if (isOwner(event.author)) return;
      if (!(await botIsAdmin(jid))) return;

      const expected = expectedRemovals.get(jid) || new Set();
      const victims = participants.filter(user => !sameUser(user, selfJid) && !expected.has(baseJid(user)));

      for (const victim of victims) {
        // The removal event reports the member by whatever identifier the server
        // used, which is frequently a LID. groupParticipantsUpdate rejects a LID
        // with a bare "bad-request" (same trap as .kick/.block), so translate
        // first and say so plainly when the number is not known yet.
        const target = toPhoneJid(victim);
        if (!target) {
          warn(`[antikick] no phone number known for ${victim}; cannot re-add`);
          await send(jid, {
            text: `⚠️ antikick: I only have a LID for ${mention(victim)}, and WhatsApp needs a phone number to re-add.`,
            mentions: [victim]
          }).catch(() => {});
          continue;
        }

        try {
          await socket.groupParticipantsUpdate(jid, [target], 'add');
          await send(jid, {
            text: `🛡️ antikick: re-added ${mention(target)} (removal by ${mention(event.author || '')} undone).`,
            mentions: [target, event.author].filter(Boolean)
          });
        } catch (error) {
          warn(`[antikick] could not re-add ${target}: ${error?.message || error}`);
          await send(jid, { text: `⚠️ antikick could not re-add ${mention(target)}.`, mentions: [target] }).catch(() => {});
        }
      }
    }
  };

  // ---------------------------------------------------------------------
  // call: anticall (a global, owner-controlled setting - not per group)
  // ---------------------------------------------------------------------
  tools.handleCall = async calls => {
    const anticall = Boolean(globalStore?.get('anticall'));
    const rejected = [];

    for (const call of calls || []) {
      const from = call?.from;
      if (!from) continue;

      // Log every call, not just the rejected ones: "a call came in and the bot
      // stayed quiet" is exactly the ambiguity that makes a console useless.
      if (!anticall) {
        log(`📞 incoming ${call.isVideo ? 'video ' : ''}call from ${from} - anticall is off, not rejected`);
        continue;
      }

      if (isOwner(from)) {
        log(`📞 incoming call from ${from} (owner) - not rejected`);
        continue;
      }

      try {
        await socket.rejectCall(call.id, from);
        rejected.push(from);
        log(`📵 rejected call from ${from}`);
      } catch (error) {
        warn(`[anticall] reject failed for ${from}: ${error?.message || error}`);
      }
    }

    return rejected;
  };

  return tools;
}

module.exports = {
  createMessageTools,
  GROUP_DEFAULTS,
  RENAMED_SETTINGS,
  migrateSettings,
  textOf,
  mediaTypeOf,
  mediaKeyOf,
  isMediaMessage,
  isStickerSource,
  numberOf,
  baseJid,
  sameUser,
  isGroup,
  mention,
  formatRuntime,
  groupLinkOf,
  anyLinkOf
};
