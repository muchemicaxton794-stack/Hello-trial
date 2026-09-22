'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, createObjectStore } = require('../src/store');
const { createMessageTools, GROUP_DEFAULTS } = require('../src/msg');
const { createSpamManager } = require('../src/spam');
const { createProtection } = require('../src/protected');
const { createDebugLog } = require('../src/debug-log');

const BOT = '15550000000:5@s.whatsapp.net'; // paired account, with a device suffix
const GROUP = '120363000000000000@g.us';
const ADMIN = '15551110000@s.whatsapp.net';
const MEMBER = '15552220000@s.whatsapp.net';
const OUTSIDER = '15553330000@s.whatsapp.net';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hellotrial-test-'));
}

function mockSocket({ user = BOT, participants, subject = 'Test Group' } = {}) {
  const groupParticipants =
    participants ||
    [
      { id: BOT, admin: 'admin' },
      { id: ADMIN, admin: 'admin' },
      { id: MEMBER },
      { id: OUTSIDER }
    ];

  const calls = {
    sendMessage: [],
    groupParticipantsUpdate: [],
    updateBlockStatus: [],
    rejectCall: [],
    requestPairingCode: 0
  };

  return {
    user: { id: user },
    calls,
    ev: { on() {} },
    async sendMessage(jid, content, extra) {
      calls.sendMessage.push({ jid, content, extra });
      return { key: { id: `sent-${calls.sendMessage.length}` } };
    },
    async groupMetadata() {
      return { subject, participants: groupParticipants, creation: 1700000000, desc: 'test group' };
    },
    async groupParticipantsUpdate(jid, users, action) {
      calls.groupParticipantsUpdate.push({ jid, users, action });
      return users.map(() => ({ status: '200' }));
    },
    async updateBlockStatus(jid, action) {
      calls.updateBlockStatus.push({ jid, action });
    },
    async rejectCall(id, from) {
      calls.rejectCall.push({ id, from });
    },
    async groupRevokeInvite() {
      return 'NEWINVITE';
    },
    async groupUpdateSubject() {},
    async groupUpdateDescription() {},
    async requestPairingCode() {
      calls.requestPairingCode += 1;
      return 'ABCD1234';
    }
  };
}

function buildMessage({
  text = '',
  jid = GROUP,
  sender = MEMBER,
  fromMe = false,
  id = 'MSG1',
  quoted = null,
  media = null,
  ageSeconds = 0
} = {}) {
  const key = { remoteJid: jid, fromMe, id, participant: jid.endsWith('@g.us') ? sender : undefined };
  const messageTimestamp = Math.floor(Date.now() / 1000) - ageSeconds;
  if (quoted) {
    return {
      key,
      messageTimestamp,
      message: {
        extendedTextMessage: {
          text,
          contextInfo: {
            participant: quoted.sender || ADMIN,
            stanzaId: quoted.id || 'QUOTED1',
            quotedMessage: quoted.message
          }
        }
      }
    };
  }
  if (media === 'image') {
    return {
      key,
      messageTimestamp,
      message: { imageMessage: { caption: text, mimetype: 'image/jpeg' }, extendedTextMessage: undefined }
    };
  }
  return { key, messageTimestamp, message: { conversation: text } };
}

/**
 * Mirrors the production wiring in src/index.js: the same SpamManager, the same
 * protection gate and the same debug logger are injected here, so a test cannot
 * pass against a configuration the bot never actually runs.
 */
function buildTools({
  socket,
  mode = 'public',
  dir = tempDir(),
  spam = {},
  protectedUsers = [],
  ownerNumbers = []
} = {}) {
  const settingsStore = createObjectStore({ file: path.join(dir, 'settings.json'), defaults: GROUP_DEFAULTS });
  const ownersStore = createStore({ file: path.join(dir, 'owners.json'), defaults: { owners: [] } });
  const globalStore = createStore({
    file: path.join(dir, 'global.json'),
    defaults: { anticall: false, mode: '', pairWelcomePending: false, pairWelcomeAttempts: 0 }
  });

  const spamManager = createSpamManager({
    windowSeconds: 10,
    messageLimit: 6,
    action: 'delete+warn',
    warnLimit: 2,
    ...spam
  });

  const spamProtection = createProtection({
    socket,
    ownerNumbers,
    extraNumbers: protectedUsers,
    sudoStore: ownersStore,
    log: () => {}
  });

  // Both info and warning output land here so a test can assert on either.
  const logs = [];
  const debugLines = [];
  const debug = createDebugLog({ sink: line => debugLines.push(line) });

  const tools = {
    ...createMessageTools({
      socket,
      botName: 'bigbrother edition',
      prefix: '.',
      mode,
      settingsStore,
      ownersStore,
      globalStore,
      spamManager,
      spamProtection,
      debug,
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' '))
    }),
    menuImageUrl: '',
    setMode(value) {
      tools.mode = value;
    }
  };

  return { tools, socket, settingsStore, ownersStore, globalStore, logs, debugLines, spamManager, dir };
}

/** All text sent back to the chat, joined for easy assertions. */
function sentText(socket) {
  return socket.calls.sendMessage.map(entry => entry.content?.text || '').join('\n');
}

module.exports = {
  BOT,
  GROUP,
  ADMIN,
  MEMBER,
  OUTSIDER,
  tempDir,
  mockSocket,
  buildMessage,
  buildTools,
  sentText
};
