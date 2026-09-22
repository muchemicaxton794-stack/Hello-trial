'use strict';

/**
 * Dependency-free test runner: `npm test`.
 *
 * Every test that pins a fix is written against a fake socket, so the suite
 * needs no WhatsApp account and no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { runBigBroCommand, menuText, MENU_CATEGORIES, packMenuCommands } = require('../src/bigbro');
const { createObjectStore, createStore } = require('../src/store');
const { GROUP_DEFAULTS } = require('../src/msg');
const { createPairing } = require('../src/pairing');
const { createInboundHandler, isIgnoredChat } = require('../src/inbound');
const {
  DEFAULT_PAIR_WELCOME,
  pairWelcomeText,
  markPairWelcomePending,
  deliverPairWelcome
} = require('../src/welcome');
const {
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
} = require('./helpers');

const tests = [];
const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
const test = (name, fn) => tests.push({ name, fn });

async function dispatch(tools, message) {
  const parsed = tools.parseCommand(message);
  if (!parsed) return null;
  return runBigBroCommand({ ...parsed, ...tools });
}

// ---------------------------------------------------------------------------
test('parseCommand splits the prefix, command and arguments', async () => {
  const { tools } = buildTools({ socket: mockSocket() });

  assert.strictEqual(tools.parseCommand(buildMessage({ text: 'hello there' })), null);
  assert.strictEqual(tools.parseCommand(buildMessage({ text: '.' })), null);

  const ping = tools.parseCommand(buildMessage({ text: '.ping' }));
  assert.strictEqual(ping.command, 'ping');
  assert.deepStrictEqual(ping.args, []);

  const music = tools.parseCommand(buildMessage({ text: '.music never gonna give' }));
  assert.strictEqual(music.command, 'music');
  assert.deepStrictEqual(music.args, ['never', 'gonna', 'give']);

  const upper = tools.parseCommand(buildMessage({ text: '.PING' }));
  assert.strictEqual(upper.command, 'ping');
});

// ---------------------------------------------------------------------------
test('group settings are created with defaults and persist atomically', async () => {
  const dir = tempDir();
  const { tools } = buildTools({ socket: mockSocket(), dir });

  const config = tools.groupSettings(GROUP);
  for (const key of Object.keys(GROUP_DEFAULTS)) assert.strictEqual(config[key], false, `${key} default`);

  config.antilink = true;
  tools.saveSettings();

  const reread = createObjectStore({ file: path.join(dir, 'settings.json'), defaults: GROUP_DEFAULTS });
  assert.strictEqual(reread.get(GROUP).antilink, true);
  assert.ok(!fs.existsSync(`${path.join(dir, 'settings.json')}.${process.pid}.tmp`), 'no temp file left behind');
});

test('a stored group gains toggles added in later versions', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ [GROUP]: { antilink: true } }));

  const store = createObjectStore({ file, defaults: GROUP_DEFAULTS });
  const config = store.get(GROUP);
  assert.strictEqual(config.antilink, true, 'existing value preserved');
  assert.strictEqual(config.antikick, false, 'new toggle materialised');
  assert.strictEqual(config.welcome, false, 'new toggle materialised');
});

test('a corrupt settings file is quarantined, not silently dropped', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "broken": ');

  const originalError = console.error;
  console.error = () => {};
  let store;
  try {
    store = createObjectStore({ file, defaults: GROUP_DEFAULTS });
  } finally {
    console.error = originalError;
  }

  assert.deepStrictEqual(store.all(), {}, 'starts from defaults');
  const quarantined = fs.readdirSync(dir).filter(name => name.includes('corrupt'));
  assert.strictEqual(quarantined.length, 1, 'damaged file kept for inspection');
  assert.ok(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8').includes('"broken"'));
});

// ---------------------------------------------------------------------------
test('antilink deletes links from members but never from admins or owners', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antilink = true;

  const fromMember = buildMessage({ text: 'see https://example.com', sender: MEMBER });
  assert.strictEqual(await tools.handleProtection(fromMember), true, 'member link handled');
  assert.deepStrictEqual(socket.calls.sendMessage.at(-1).content, { delete: fromMember.key });

  const fromAdmin = buildMessage({ text: 'see https://example.com', sender: ADMIN });
  assert.strictEqual(await tools.handleProtection(fromAdmin), false, 'admins are exempt');

  const clean = buildMessage({ text: 'no links here', sender: MEMBER });
  assert.strictEqual(await tools.handleProtection(clean), false, 'clean message untouched');

  const own = buildMessage({ text: 'https://example.com', sender: BOT, fromMe: true });
  assert.strictEqual(await tools.handleProtection(own), false, 'own messages untouched');
});

test('gclink only targets group invite links', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).gclink = true; // antilink stays off

  const plain = buildMessage({ text: 'look at https://example.com', sender: MEMBER });
  assert.strictEqual(await tools.handleProtection(plain), false, 'ordinary link survives gclink');

  const invite = buildMessage({ text: 'join https://chat.whatsapp.com/ABC123', sender: MEMBER });
  assert.strictEqual(await tools.handleProtection(invite), true, 'invite link deleted');
});

test('antibot deletes web-client (3EB0) messages from members only', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antibot = true;

  const botLike = buildMessage({ text: 'beep', sender: MEMBER, id: '3EB0DEADBEEF123456' });
  assert.strictEqual(await tools.handleProtection(botLike), true);

  const human = buildMessage({ text: 'beep', sender: MEMBER, id: 'ABCDEF123456' });
  assert.strictEqual(await tools.handleProtection(human), false);

  const adminBotLike = buildMessage({ text: 'beep', sender: ADMIN, id: '3EB0DEADBEEF123456' });
  assert.strictEqual(await tools.handleProtection(adminBotLike), false, 'admin exempt');
});

test('AntiMessage deletes a duplicate flood once the SpamManager fires', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antimessage = true;

  // One long, entirely normal message must not trigger anything (§6).
  const longButNormal = buildMessage({
    text: 'Good morning everyone, here are the notes from yesterday about the supplier agreement and next month delivery schedule.',
    sender: MEMBER
  });
  assert.strictEqual(await tools.handleProtection(longButNormal), false, 'a single long message is never spam');

  let deleted = false;
  for (let index = 0; index < 3; index += 1) {
    deleted = await tools.handleProtection(buildMessage({ text: 'same thing', sender: MEMBER }));
  }
  assert.strictEqual(deleted, true, '3rd identical message deleted');
});

test('AntiMessage ignores normal conversation', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antimessage = true;

  for (const line of ['Sawa profesa Kapuya', 'Kuja ukuwe kitanda', 'Niambie my lufff']) {
    assert.strictEqual(await tools.handleProtection(buildMessage({ text: line, sender: MEMBER })), false);
  }
  assert.strictEqual(socket.calls.sendMessage.length, 0, 'nothing deleted, nothing sent');
});

test('AutoBlock waits for the real threshold, then blocks once', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, spam: { messageLimit: 6 } });
  tools.groupSettings(GROUP).autoblock = true;

  for (let index = 0; index < 5; index += 1) {
    await tools.handleProtection(buildMessage({ text: `message ${index}`, sender: MEMBER }));
  }
  assert.strictEqual(socket.calls.updateBlockStatus.length, 0, 'not blocked before the threshold');

  await tools.handleProtection(buildMessage({ text: 'message 6', sender: MEMBER }));
  assert.deepStrictEqual(socket.calls.updateBlockStatus, [{ jid: MEMBER, action: 'block' }]);

  // A continued burst must not block the same person repeatedly.
  await tools.handleProtection(buildMessage({ text: 'message 7', sender: MEMBER }));
  assert.strictEqual(socket.calls.updateBlockStatus.length, 1, 'no duplicate punishment');
});

test('protected users are exempt from every automatic action', async () => {
  const socket = mockSocket();
  const { tools, debugLines } = buildTools({ socket, protectedUsers: ['15552220000'] });
  tools.groupSettings(GROUP).antimessage = true;
  tools.groupSettings(GROUP).autoblock = true;

  for (let index = 0; index < 10; index += 1) {
    await tools.handleProtection(buildMessage({ text: 'spam spam spam', sender: MEMBER }));
  }

  assert.strictEqual(socket.calls.sendMessage.length, 0, 'nothing deleted for a protected user');
  assert.strictEqual(socket.calls.updateBlockStatus.length, 0, 'never blocked');
  assert.ok(debugLines.some(line => line.includes('whitelist')), 'the reason is logged');
});

test('AntiSticker deletes stickers but never images, videos or GIFs', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antisticker = true;

  const sticker = { key: { remoteJid: GROUP, fromMe: false, id: 'S1', participant: MEMBER }, message: { stickerMessage: { mimetype: 'image/webp' } } };
  assert.strictEqual(await tools.handleProtection(sticker), true, 'sticker deleted');

  const image = { key: { remoteJid: GROUP, fromMe: false, id: 'S2', participant: MEMBER }, message: { imageMessage: { mimetype: 'image/jpeg' } } };
  assert.strictEqual(await tools.handleProtection(image), false, 'image untouched');

  const video = { key: { remoteJid: GROUP, fromMe: false, id: 'S3', participant: MEMBER }, message: { videoMessage: { mimetype: 'video/mp4' } } };
  assert.strictEqual(await tools.handleProtection(video), false, 'video untouched');

  // A GIF is a videoMessage with gifPlayback, not a sticker.
  const gif = { key: { remoteJid: GROUP, fromMe: false, id: 'S4', participant: MEMBER }, message: { videoMessage: { mimetype: 'video/mp4', gifPlayback: true } } };
  assert.strictEqual(await tools.handleProtection(gif), false, 'GIF untouched');

  const document = { key: { remoteJid: GROUP, fromMe: false, id: 'S5', participant: MEMBER }, message: { documentMessage: { mimetype: 'application/pdf' } } };
  assert.strictEqual(await tools.handleProtection(document), false, 'document untouched');
});

// ---------------------------------------------------------------------------
test('anticall rejects calls from strangers but never from the owner', async () => {
  const socket = mockSocket();
  const { tools, globalStore } = buildTools({ socket });
  globalStore.set('anticall', true);

  const rejected = await tools.handleCall([
    { id: 'CALL1', from: OUTSIDER },
    { id: 'CALL2', from: BOT.replace(':5', '') }
  ]);

  assert.deepStrictEqual(rejected, [OUTSIDER], 'only the stranger is rejected');
  assert.strictEqual(socket.calls.rejectCall.length, 1);

  globalStore.set('anticall', false);
  assert.deepStrictEqual(await tools.handleCall([{ id: 'CALL3', from: OUTSIDER }]), []);
});

// ---------------------------------------------------------------------------
test('REGRESSION: a stranger cannot use .block in a direct message', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  const dm = buildMessage({ text: '.block 15559999999', jid: OUTSIDER, sender: OUTSIDER });
  await dispatch(tools, dm);

  assert.strictEqual(socket.calls.updateBlockStatus.length, 0, 'no block performed');
  assert.match(sentText(socket), /Only the bot owner/);
});

test('the owner can use .block and .unblock', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  const ownerDm = BOT.replace(':5', '');

  await dispatch(tools, buildMessage({ text: '.block 15559999999', jid: ownerDm, sender: ownerDm }));
  await dispatch(tools, buildMessage({ text: '.unblock 15559999999', jid: ownerDm, sender: ownerDm }));

  assert.deepStrictEqual(socket.calls.updateBlockStatus, [
    { jid: '15559999999@s.whatsapp.net', action: 'block' },
    { jid: '15559999999@s.whatsapp.net', action: 'unblock' }
  ]);
});

test('a group admin cannot use owner-only commands', async () => {
  const socket = mockSocket();
  const { tools, globalStore } = buildTools({ socket });

  await dispatch(tools, buildMessage({ text: '.anticall on', sender: ADMIN }));
  assert.strictEqual(globalStore.get('anticall'), false, 'global setting untouched');
  assert.match(sentText(socket), /Only the bot owner/);
});

test('the menu renders the decorated template', () => {
  const text = menuText('𝓓𝓐𝓡𝓚𝓝𝓞𝚃𝙴  Bot', '.');
  const lines = text.split('\n');

  assert.strictEqual(lines[0], '╭━≫〖 *𝓓𝓐𝓡𝓚𝓝𝓞𝚃𝙴  Bot* 〗≪━╮', 'header');

  // One block per category, each opened and closed in the template's shape.
  assert.strictEqual(lines.filter(line => line === '┇ ╭────↯').length, MENU_CATEGORIES.length);
  assert.strictEqual(lines.filter(line => line === "┇ ╰────↯'").length, MENU_CATEGORIES.length);
  assert.strictEqual(lines.filter(line => line === '┗━━━━━━━━━━━━━━━━━━〣').length, MENU_CATEGORIES.length);

  // A divider between blocks, not after the last one.
  assert.strictEqual(lines.filter(line => line === '  ━━━━━━━━━━━━━━━━━━').length, MENU_CATEGORIES.length - 1);

  for (const category of MENU_CATEGORIES) {
    assert.ok(text.includes(`┇ │ _\`${category.title}\`_`), `${category.title} heading`);
    for (const command of category.commands) {
      assert.ok(text.includes(`_\`${command}\`_`), `${category.title} lists ${command}`);
    }
  }
});

test('menu command lines wrap instead of being reflowed by the client', () => {
  const lines = packMenuCommands(MENU_CATEGORIES.find(category => category.title === 'PROTECTION').commands);

  assert.ok(lines.length > 1, 'a long category spans several lines');
  for (const line of lines) {
    const visible = line.replace(/[`_]/g, '').length;
    assert.ok(visible <= 34, `"${line}" is ${visible} visible chars`);
  }
  // Nothing may be dropped while packing.
  const packed = lines.join('  ').replace(/[`_]/g, '').split(/\s{2,}/);
  for (const command of MENU_CATEGORIES.find(category => category.title === 'PROTECTION').commands) {
    assert.ok(packed.includes(command), `${command} survived packing`);
  }
});

test('every command the menu advertises is listed in exactly one category', () => {
  const seen = new Set();
  for (const category of MENU_CATEGORIES) {
    for (const command of category.commands) {
      const name = command.split(/\s/)[0];
      assert.ok(!seen.has(name), `${name} appears twice`);
      seen.add(name);
    }
  }
  for (const required of ['menu', 'ping', 'sticker', 'music', 'antilink', 'antikick', 'kick', 'tagall', 'block', 'mode']) {
    assert.ok(seen.has(required), `${required} is advertised`);
  }
});

test('every toggle advertised in the menu changes real state', async () => {
  // This is the regression test for the four toggles that used to reply
  // "✅ is now on" while nothing in the code ever read the flag.
  const socket = mockSocket();
  const { tools, settingsStore, globalStore, ownersStore } = buildTools({ socket });
  // Make the acting admin an owner as well, so owner-scoped toggles (.anticall)
  // are reachable in the same sweep.
  ownersStore.set('owners', ['15551110000']);

  // Derived from the same list the menu renders, so a toggle cannot be shown
  // without being wired up - the original bug replied "✅ is now on" and did
  // nothing at all for four of these.
  const advertised = MENU_CATEGORIES.flatMap(category => category.commands)
    .map(entry => entry.match(/^([a-z]+) on\|off$/))
    .filter(Boolean)
    .map(match => match[1]);
  assert.ok(advertised.length >= 10, `menu advertises the toggles (found ${advertised.length})`);

  for (const name of advertised) {
    await dispatch(tools, buildMessage({ text: `.${name} on`, sender: ADMIN }));
    const groupFlag = settingsStore.has(GROUP) ? settingsStore.get(GROUP)[name] : undefined;
    const globalFlag = globalStore.get(name);
    assert.strictEqual(
      groupFlag === true || globalFlag === true,
      true,
      `.${name} must actually store a flag (group=${groupFlag}, global=${globalFlag})`
    );
  }
});

test('.resetgroup restores the defaults', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antilink = true;

  await dispatch(tools, buildMessage({ text: '.resetgroup', sender: ADMIN }));
  assert.strictEqual(tools.groupSettings(GROUP).antilink, false);
});

// ---------------------------------------------------------------------------
test('REGRESSION: .sticker downloads the quoted image, not the command text', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  let captured = null;
  tools.downloadMedia = async source => {
    captured = source;
    return Buffer.from('fake-sticker-bytes');
  };

  const reply = buildMessage({
    text: '.sticker',
    sender: MEMBER,
    quoted: { message: { imageMessage: { mimetype: 'image/jpeg' } }, id: 'QUOTED9', sender: ADMIN }
  });

  await dispatch(tools, reply);

  assert.ok(captured, 'downloadMedia was called');
  assert.ok(captured.message.imageMessage, 'the quoted image was downloaded');
  assert.strictEqual(captured.key.id, 'QUOTED9');
  assert.ok(socket.calls.sendMessage.some(entry => entry.content.sticker), 'sticker sent');
});

test('.sticker still works when the image carries the caption', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  let captured = null;
  tools.downloadMedia = async source => {
    captured = source;
    return Buffer.from('bytes');
  };

  await dispatch(tools, buildMessage({ text: '.sticker', media: 'image', sender: MEMBER }));
  assert.ok(captured?.message?.imageMessage, 'the attachments own image is used');
});

test('.sticker explains itself when there is no image', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  await dispatch(tools, buildMessage({ text: '.sticker', sender: MEMBER }));
  assert.match(sentText(socket), /reply to an image/i);
});

// ---------------------------------------------------------------------------
test('LID-addressed groups still recognise the bot as admin', async () => {
  // Some groups list participants by LID; a naive JID string comparison makes
  // botIsAdmin() return false, which would break every admin command.
  const socket = mockSocket({
    participants: [
      { id: '111111111111111@lid', lid: '111111111111111@lid', admin: 'admin' },
      { id: ADMIN, admin: 'admin' }
    ]
  });
  // The bot is listed by LID only, and its phone JID shares no digits with it.
  socket.user = { id: BOT, lid: '111111111111111@lid' };

  const { tools } = buildTools({ socket });
  assert.strictEqual(await tools.botIsAdmin(GROUP), true);
  assert.strictEqual(await tools.isGroupAdmin(GROUP, '111111111111111@lid'), true);
});

test('kickall never includes the bot itself', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  await dispatch(tools, buildMessage({ text: '.kickall', sender: ADMIN }));

  const call = socket.calls.groupParticipantsUpdate.at(-1);
  assert.strictEqual(call.action, 'remove');
  assert.ok(!call.users.includes(BOT), 'device-suffixed bot JID excluded');
  assert.ok(!call.users.includes(BOT.replace(':5', '')), 'normalised bot JID excluded');
  assert.ok(!call.users.includes(ADMIN), 'admins excluded');
  assert.ok(call.users.includes(MEMBER), 'ordinary members targeted');
});

test('moderation requires the bot to be a group admin', async () => {
  const socket = mockSocket({ participants: [{ id: BOT }, { id: ADMIN, admin: 'admin' }, { id: MEMBER }] });
  const { tools } = buildTools({ socket });

  await dispatch(tools, buildMessage({ text: '.kick', sender: ADMIN, quoted: { message: { conversation: 'hi' }, sender: MEMBER } }));

  assert.strictEqual(socket.calls.groupParticipantsUpdate.length, 0, 'no removal attempted');
  assert.match(sentText(socket), /make bigbrother edition a group admin/);
});

// ---------------------------------------------------------------------------
test('antikick re-adds a member removed by someone else', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antikick = true;

  await tools.handleParticipants({ id: GROUP, author: OUTSIDER, participants: [MEMBER], action: 'remove' });

  assert.deepStrictEqual(socket.calls.groupParticipantsUpdate, [{ jid: GROUP, users: [MEMBER], action: 'add' }]);
  assert.match(sentText(socket), /antikick/);
});

test('REGRESSION: antikick translates a LID victim before re-adding', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  const victimLid = '216879440367848@lid';
  const victimPhone = '254700555444@s.whatsapp.net';

  tools.groupSettings(GROUP).antikick = true;
  tools.learnLidPair({ lid: victimLid, pn: victimPhone });

  await tools.handleParticipants({ id: GROUP, author: OUTSIDER, participants: [victimLid], action: 'remove' });

  assert.deepStrictEqual(socket.calls.groupParticipantsUpdate, [
    { jid: GROUP, users: [victimPhone], action: 'add' }
  ]);
  assert.match(sentText(socket), /re-added/);
});

test('antikick reports honestly when only a LID is known', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  tools.groupSettings(GROUP).antikick = true;
  await tools.handleParticipants({
    id: GROUP,
    author: OUTSIDER,
    participants: ['216879440367848@lid'],
    action: 'remove'
  });

  assert.strictEqual(socket.calls.groupParticipantsUpdate.length, 0, 'no doomed request sent');
  assert.match(sentText(socket), /only have a LID/);
});

test('antikick does not undo the bot\'s own removals', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antikick = true;

  await tools.handleParticipants({ id: GROUP, author: BOT, participants: [MEMBER], action: 'remove' });
  assert.strictEqual(socket.calls.groupParticipantsUpdate.length, 0, 'bot removal respected');

  tools.expectRemoval(GROUP, [MEMBER]);
  await tools.handleParticipants({ id: GROUP, author: ADMIN, participants: [MEMBER], action: 'remove' });
  assert.strictEqual(socket.calls.groupParticipantsUpdate.length, 0, 'requested removal respected');
});

test('welcome and goodbye only fire when enabled', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  await tools.handleParticipants({ id: GROUP, author: ADMIN, participants: [OUTSIDER], action: 'add' });
  assert.doesNotMatch(sentText(socket), /Welcome/);

  tools.groupSettings(GROUP).welcome = true;
  await tools.handleParticipants({ id: GROUP, author: ADMIN, participants: [OUTSIDER], action: 'add' });
  assert.match(sentText(socket), /Welcome/);

  tools.groupSettings(GROUP).goodbye = true;
  await tools.handleParticipants({ id: GROUP, author: ADMIN, participants: [OUTSIDER], action: 'remove' });
  assert.match(sentText(socket), /left the group/);
});

test('antidelete replays a removed text message', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.groupSettings(GROUP).antidelete = true;

  const message = buildMessage({ text: 'secret plans', sender: MEMBER, id: 'DEL1' });
  tools.remember(message);
  await tools.restoreDeleted({ id: 'DEL1', remoteJid: GROUP });

  assert.match(sentText(socket), /secret plans/);
});

// ---------------------------------------------------------------------------
test('REGRESSION: the pairing code is requested exactly once per socket', async () => {
  const socket = mockSocket();
  const dir = tempDir();

  const pairing = createPairing({
    socket,
    pairingNumber: '15550000000',
    botName: 'test bot',
    qrFile: path.join(dir, 'qr.txt'),
    log: () => {},
    warn: () => {}
  });

  assert.strictEqual(await pairing.handle({ qr: 'QR-ONE' }), 'code');
  await pairing.handle({ qr: 'QR-TWO' });
  await pairing.handle({ connection: 'connecting' });
  await pairing.handle({ qr: 'QR-THREE' });

  assert.strictEqual(socket.calls.requestPairingCode, 1, 'a second call would invalidate the displayed code');
});

test('without PAIRING_NUMBER the QR is drawn and mirrored to disk', async () => {
  const socket = mockSocket();
  const dir = tempDir();
  const qrFile = path.join(dir, 'qr.txt');

  const pairing = createPairing({ socket, pairingNumber: '', botName: 'test bot', qrFile, log: () => {}, warn: () => {} });

  assert.strictEqual(await pairing.handle({ qr: 'QR-PAYLOAD' }), 'qr');
  assert.strictEqual(socket.calls.requestPairingCode, 0, 'no pairing code requested');
  assert.strictEqual(fs.readFileSync(qrFile, 'utf8').trim(), 'QR-PAYLOAD');
});

test('a paired socket clears the QR file', async () => {
  const socket = mockSocket();
  const dir = tempDir();
  const qrFile = path.join(dir, 'qr.txt');

  const pairing = createPairing({ socket, pairingNumber: '', botName: 'test bot', qrFile, log: () => {}, warn: () => {} });
  await pairing.handle({ qr: 'QR-PAYLOAD' });
  assert.ok(fs.existsSync(qrFile));

  assert.strictEqual(await pairing.handle({ connection: 'open' }), 'open');
  assert.strictEqual(pairing.opened, true);
  assert.ok(!fs.existsSync(qrFile), 'stale QR removed once linked');
});

// ---------------------------------------------------------------------------
// The bug the user hit in production: linked to their own number, every command
// they typed arrived with fromMe=true and was skipped, so the bot looked dead.
test('REGRESSION: a command typed by the linked account (fromMe) is handled', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });
  const selfDm = BOT.replace(':5', '');

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const outcome = await handleInbound(buildMessage({ text: '.ping', jid: selfDm, fromMe: true, id: 'OWN1' }), 'notify');

  assert.strictEqual(outcome, 'command', 'the owner\'s own message must be dispatched');
  assert.match(sentText(socket), /Pong/, 'the bot replies');
});

test('REGRESSION: the owner\'s fromMe command works in a chat with someone else', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  // DM to a third party: the author is the linked account, not the recipient.
  const outcome = await handleInbound(buildMessage({ text: '.ping', jid: OUTSIDER, fromMe: true, id: 'OWN2' }), 'notify');

  assert.strictEqual(outcome, 'command');
  assert.match(sentText(socket), /Pong/);
});

test('the bot\'s own reply is not re-dispatched', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });

  await tools.reply({ key: { remoteJid: OUTSIDER } }, 'Pong!');
  const sentId = socket.calls.sendMessage.at(-1) && 'sent-1';

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const outcome = await handleInbound(
    buildMessage({ text: '.ping', jid: OUTSIDER, fromMe: true, id: sentId }),
    'notify'
  );

  assert.strictEqual(outcome, 'self-sent', 'our own output must never loop back');
  assert.strictEqual(socket.calls.sendMessage.length, 1, 'no extra reply');
});

test('a reply whose text starts with the prefix cannot trigger itself', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });

  await tools.send(OUTSIDER, { text: '.ping' }); // a hypothetical self-echo
  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const outcome = await handleInbound(buildMessage({ text: '.ping', jid: OUTSIDER, fromMe: true, id: 'sent-1' }), 'notify');
  assert.strictEqual(outcome, 'self-sent');
  assert.strictEqual(socket.calls.sendMessage.length, 1);
});

test('a replayed history message never fires a command', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'public' });

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  // 3 days old: this is what history sync looks like.
  const old = buildMessage({ text: '.ping', sender: MEMBER, id: 'OLD1', ageSeconds: 3 * 86400 });
  assert.strictEqual(await handleInbound(old, 'append'), 'replay');
  assert.strictEqual(socket.calls.sendMessage.length, 0, 'no reply to a replayed message');
});

test('REGRESSION: a recent command tagged "append" is still handled', async () => {
  // Baileys labels live messages 'append' when the notification is flagged
  // offline - which is exactly how a message from your own account arrives.
  // Trusting the type swallowed real commands.
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });
  const selfDm = BOT.replace(':5', '');

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const fresh = buildMessage({ text: '.ping', jid: selfDm, fromMe: true, id: 'OWN3', ageSeconds: 4 });
  assert.strictEqual(await handleInbound(fresh, 'append'), 'command');
  assert.match(sentText(socket), /Pong/);
});

test('a message with no timestamp is treated as live', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'public' });
  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const message = buildMessage({ text: '.ping', sender: MEMBER, id: 'NOTS' });
  delete message.messageTimestamp;
  assert.strictEqual(await handleInbound(message, 'notify'), 'command');
});

test('status broadcasts, channels and empty payloads are skipped', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'public' });
  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  assert.strictEqual(await handleInbound({ key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: '.ping' } }), 'skipped');
  assert.strictEqual(await handleInbound({ key: { remoteJid: '123456789012345@newsletter', id: 'S3' }, message: { conversation: '.ping' } }), 'skipped');
  assert.strictEqual(await handleInbound({ key: { remoteJid: OUTSIDER, id: 'S2' } }), 'skipped');
  assert.strictEqual(isIgnoredChat('120363425039896159@newsletter'), true);
  assert.strictEqual(isIgnoredChat(OUTSIDER), false);
});

test('REGRESSION: a LID target is translated to a phone number before blocking', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });
  const ownerDm = BOT.replace(':5', '');
  const lid = '107654093496469@lid';
  const phone = '254700111222@s.whatsapp.net';

  // WhatsApp hands us the pair on an incoming message (group form).
  tools.remember({ key: { id: 'PAIR1', remoteJid: GROUP, participant: lid, participantLid: lid, participantPn: phone } });

  assert.strictEqual(tools.toPhoneJid(lid), phone, 'pair learned from the message key');

  // Reply to that person and block them.
  const reply = buildMessage({
    text: '.block',
    jid: ownerDm,
    sender: ownerDm,
    fromMe: true,
    quoted: { message: { conversation: 'hi' }, sender: lid, id: 'Q1' }
  });
  await dispatch(tools, reply);

  assert.deepStrictEqual(socket.calls.updateBlockStatus, [{ jid: phone, action: 'block' }]);
});

test('a DM sender LID is learned from senderLid/senderPn and from phoneNumberShare', async () => {
  const socket = mockSocket();
  const { tools, logs } = buildTools({ socket, mode: 'self' });
  const ownerDm = BOT.replace(':5', '');
  const lid = '107654093496469@lid';
  const phone = '254700999888@s.whatsapp.net';

  // DM form: no participant fields, only the sender fields.
  tools.remember({ key: { id: 'DM1', remoteJid: lid, fromMe: false, senderLid: lid, senderPn: phone } });
  assert.strictEqual(tools.toPhoneJid(lid), phone, 'learned from a DM key');
  assert.match(logs.join('\n'), /\[lid\] learned/);

  // And the dedicated event, for a second identity.
  tools.learnLidPair({ lid: '222333444555666@lid', pn: '254711222333@s.whatsapp.net' });
  assert.strictEqual(tools.toPhoneJid('222333444555666@lid'), '254711222333@s.whatsapp.net');

  // Blocking the newly learned LID now works.
  await dispatch(
    tools,
    buildMessage({
      text: '.block',
      jid: ownerDm,
      sender: ownerDm,
      fromMe: true,
      quoted: { message: { conversation: 'hi' }, sender: lid, id: 'Q4' }
    })
  );
  assert.deepStrictEqual(socket.calls.updateBlockStatus, [{ jid: phone, action: 'block' }]);
});

test('blocking an untranslatable LID explains itself instead of failing opaquely', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });
  const ownerDm = BOT.replace(':5', '');

  const reply = buildMessage({
    text: '.block',
    jid: ownerDm,
    sender: ownerDm,
    fromMe: true,
    quoted: { message: { conversation: 'hi' }, sender: '999999999999999@lid', id: 'Q2' }
  });
  await dispatch(tools, reply);

  assert.strictEqual(socket.calls.updateBlockStatus.length, 0, 'no doomed request sent');
  assert.match(sentText(socket), /only known to me by LID/);
  assert.match(sentText(socket), /\.block 2547/);
});

test('group moderation translates LIDs and reports ones it cannot', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });

  await tools.handleParticipants({ id: GROUP, author: '111@lid', participants: [{ id: '254700111222@s.whatsapp.net', lid: '111@lid' }], action: 'add' });

  const unknown = buildMessage({
    text: '.kick',
    sender: ADMIN,
    quoted: { message: { conversation: 'x' }, sender: '888888888888888@lid', id: 'Q3' }
  });
  await dispatch(tools, unknown);

  assert.strictEqual(socket.calls.groupParticipantsUpdate.length, 0);
  assert.match(sentText(socket), /No phone number known/);
});

test('every outgoing message is logged with the chat and a preview', async () => {
  const socket = mockSocket();
  const { tools, logs } = buildTools({ socket, mode: 'public' });

  await tools.send(GROUP, { text: 'first line\nsecond line\nthird line' });
  await tools.send(OUTSIDER, { image: Buffer.from('x'), caption: 'pic' });
  await tools.send(GROUP, { delete: { id: 'K1' } });

  const out = logs.filter(line => line.startsWith('[out]'));
  assert.strictEqual(out[0], `[out] group ${GROUP} "first line" …(+2 lines)`);
  assert.strictEqual(out[1], `[out] dm ${OUTSIDER} "pic"`);
  assert.strictEqual(out[2], `[out] group ${GROUP} [delete]`);
});

test('credentials pasted into a chat are scrubbed from the log', async () => {
  const { redact, previewText } = require('../src/redact');

  const github = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
  assert.strictEqual(redact(`here is my token ${github} ok`), `here is my token ghp_«redacted:${github.length}» ok`);
  assert.ok(!redact(github).includes(github.slice(10)), 'the body is gone');

  assert.match(redact(`openai sk-${'x'.repeat(40)}`), /sk-«redacted:43»/);
  assert.match(redact('groq gsk_' + 'y'.repeat(40)), /gsk_«redacted:44»/);
  assert.match(redact('aws AKIAIOSFODNN7EXAMPLE'), /AKIA«redacted:20»/);
  assert.match(redact('slack xoxb-123456789012-abcdefghijkl'), /xoxb-«redacted:/);
  assert.match(redact(`telegram ${'123456789'}:${'A'.repeat(35)}`), /«redacted:45»/);

  // Ordinary conversation must survive untouched.
  const normal = 'Sawa profesa Kapuya 😅 https://chat.whatsapp.com/DafvifyVS6VIAox3QMYHTK call me on 15550000000';
  assert.strictEqual(redact(normal), normal);

  assert.strictEqual(previewText('plain text', { hideText: true }), '[text hidden: 10 chars]');
  assert.strictEqual(previewText(github, { hideText: false }), `ghp_«redacted:${github.length}»`);
});

test('calls are logged with the caller, including when anticall is off', async () => {
  const socket = mockSocket();
  const { tools, globalStore, logs } = buildTools({ socket });

  globalStore.set('anticall', false);
  await tools.handleCall([{ id: 'C1', from: OUTSIDER }]);
  assert.match(logs.join('\n'), /incoming call from 15553330000@s\.whatsapp\.net - anticall is off/);

  globalStore.set('anticall', true);
  await tools.handleCall([{ id: 'C2', from: OUTSIDER, isVideo: true }]);
  assert.match(logs.join('\n'), /rejected call from 15553330000@s\.whatsapp\.net/);

  await tools.handleCall([{ id: 'C3', from: BOT.replace(':5', '') }]);
  assert.match(logs.join('\n'), /from 15550000000@s\.whatsapp\.net \(owner\) - not rejected/);
});

// ---------------------------------------------------------------------------
test('the owner is recognised under their LID as well as their number', async () => {
  const socket = mockSocket();
  socket.user = { id: BOT, lid: '252119428927664:2@lid' };
  const { tools } = buildTools({ socket, mode: 'self' });

  assert.strictEqual(await tools.isOwner(BOT.replace(':5', '')), true, 'by phone number');
  assert.strictEqual(await tools.isOwner('252119428927664:9@lid'), true, 'by LID');
  assert.strictEqual(await tools.isOwner('252119428927664@lid'), true, 'by LID without device suffix');
  assert.strictEqual(await tools.isOwner(OUTSIDER), false, 'strangers stay strangers');

  const handleInbound = createInboundHandler({
    tools,
    dispatch: parsed => runBigBroCommand({ ...parsed, ...tools }),
    log: () => {}
  });

  const fromLid = buildMessage({ text: '.ping', jid: '252119428927664@lid', sender: '252119428927664@lid', id: 'LID1' });
  assert.strictEqual(await handleInbound(fromLid, 'notify'), 'command');
  assert.match(sentText(socket), /Pong/);
});

// ---------------------------------------------------------------------------
test('libsignal session dumps are suppressed and Bad MAC is counted', async () => {
  const { installLogFilters } = require('../src/log-noise');
  const lines = [];
  const originalError = console.error;

  const filters = installLogFilters({ log: line => lines.push(line), intervalMs: 20 });
  try {
    console.info('Closing session:', { secret: 'private-key-material' });
    console.error('Session error:Error: Bad MAC', 'at verifyMAC (...)');
    console.error('Session error:Error: Bad MAC', 'at verifyMAC (...)');
    console.error('a genuine error that must survive');
  } finally {
    assert.strictEqual(filters.badMacCount, 2);
  }

  await new Promise(resolve => setTimeout(resolve, 40));
  filters.uninstall();
  console.error = originalError;

  assert.strictEqual(lines.length, 1, 'exactly one summary');
  assert.match(lines[0], /2 message\(s\) could not be decrypted/);
});

// ---------------------------------------------------------------------------
test('pairing welcome is queued on a new login and sent once the socket opens', async () => {
  const socket = mockSocket();
  const { globalStore } = buildTools({ socket });

  assert.strictEqual(globalStore.get('pairWelcomePending'), false, 'nothing queued at boot');
  markPairWelcomePending(globalStore);

  const result = await deliverPairWelcome({ socket, globalStore, log: () => {}, warn: () => {} });

  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.jid, '15550000000@s.whatsapp.net', 'device suffix stripped from the paired number');
  assert.strictEqual(socket.calls.sendMessage[0].content.text, DEFAULT_PAIR_WELCOME);
  assert.strictEqual(globalStore.get('pairWelcomePending'), false, 'flag cleared after delivery');
  assert.ok(globalStore.get('pairWelcomeSentAt'), 'delivery timestamp recorded');
});

test('the pairing welcome is not resent on a plain reconnect', async () => {
  const socket = mockSocket();
  const { globalStore } = buildTools({ socket });

  const result = await deliverPairWelcome({ socket, globalStore, log: () => {}, warn: () => {} });
  assert.strictEqual(result.sent, false);
  assert.match(result.reason, /pending/);
  assert.strictEqual(socket.calls.sendMessage.length, 0);
});

test('the welcome copy can be overridden and force bypasses the pending flag', async () => {
  const socket = mockSocket();
  const { globalStore } = buildTools({ socket });

  const result = await deliverPairWelcome({
    socket,
    globalStore,
    text: 'custom hello',
    force: true,
    log: () => {},
    warn: () => {}
  });

  assert.strictEqual(result.sent, true);
  assert.strictEqual(socket.calls.sendMessage[0].content.text, 'custom hello');
  assert.strictEqual(pairWelcomeText('   '), DEFAULT_PAIR_WELCOME, 'blank falls back to the default copy');
});

test('a failed welcome is retried and then gives up', async () => {
  const socket = mockSocket();
  socket.sendMessage = async () => {
    throw new Error('socket offline');
  };
  const { globalStore } = buildTools({ socket });
  markPairWelcomePending(globalStore);

  const warnings = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await deliverPairWelcome({ socket, globalStore, log: () => {}, warn: message => warnings.push(message) });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'socket offline');
  }

  assert.strictEqual(globalStore.get('pairWelcomePending'), false, 'stops retrying after the cap');
  assert.match(warnings.at(-1), /giving up after 3 attempts/);
});

test('the welcome stays queued when the socket has no identity yet', async () => {
  const socket = mockSocket();
  socket.user = undefined;
  const { globalStore } = buildTools({ socket });
  markPairWelcomePending(globalStore);

  const result = await deliverPairWelcome({ socket, globalStore, log: () => {}, warn: () => {} });
  assert.strictEqual(result.sent, false);
  assert.match(result.reason, /no identity/);
  assert.strictEqual(globalStore.get('pairWelcomePending'), true, 'retried on the next open');
});

// ---------------------------------------------------------------------------
test('self mode ignores strangers entirely', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'self' });

  const result = await dispatch(tools, buildMessage({ text: '.ping', sender: MEMBER }));
  assert.strictEqual(result, undefined);
  assert.strictEqual(socket.calls.sendMessage.length, 0, 'no reply at all');
});

test('public mode answers utility commands', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket, mode: 'public' });

  await dispatch(tools, buildMessage({ text: '.ping', sender: MEMBER }));
  assert.match(sentText(socket), /Pong/);

  await dispatch(tools, buildMessage({ text: '.menu', sender: MEMBER }));
  assert.match(sentText(socket), /bigbrother edition/);
});

test('REGRESSION: .menu falls back to MENU_IMAGE_URL when no local file exists', async () => {
  const socket = mockSocket();
  const { tools } = buildTools({ socket });
  tools.menuImageUrl = 'https://example.com/menu.jpg';
  tools.menuImagePath = '/nonexistent/menu.jpg';

  await dispatch(tools, buildMessage({ text: '.menu', sender: MEMBER }));
  assert.deepStrictEqual(socket.calls.sendMessage[0].content.image, { url: 'https://example.com/menu.jpg' });

  const socket2 = mockSocket();
  const second = buildTools({ socket: socket2 });
  second.tools.menuImageUrl = '';
  second.tools.menuImagePath = '/nonexistent/menu.jpg';
  await dispatch(second.tools, buildMessage({ text: '.menu', sender: MEMBER }));
  assert.match(socket2.calls.sendMessage[0].content.text, /bigbrother edition/);
});

test('.mode switches the running instance and persists', async () => {
  const socket = mockSocket();
  const { tools, globalStore } = buildTools({ socket, mode: 'public' });
  const ownerDm = BOT.replace(':5', '');

  await dispatch(tools, buildMessage({ text: '.mode self', jid: ownerDm, sender: ownerDm }));
  assert.strictEqual(globalStore.get('mode'), 'self');
  assert.strictEqual(tools.mode, 'self', 'live mode updated');

  await dispatch(tools, buildMessage({ text: '.ping', sender: MEMBER }));
  assert.doesNotMatch(sentText(socket), /Pong/, 'stranger ignored after switching to self');
});

test('audio formats map to a container WhatsApp can play', async () => {
  const { audioKindOf } = require('../src/bigbro');
  assert.deepStrictEqual(audioKindOf({ mimeType: 'audio/mp4; codecs="mp4a.40.2"' }), { mimetype: 'audio/mp4', extension: 'm4a' });
  assert.deepStrictEqual(audioKindOf({ mimeType: 'audio/webm; codecs="opus"', container: 'webm' }), { mimetype: 'audio/webm', extension: 'weba' });
  assert.deepStrictEqual(audioKindOf({ mimeType: 'audio/ogg' }), { mimetype: 'audio/ogg', extension: 'ogg' });
  assert.deepStrictEqual(audioKindOf(undefined), { mimetype: 'application/octet-stream', extension: 'bin' });
});

// ---------------------------------------------------------------------------
(async () => {
  const selected = only.length ? tests.filter(entry => only.some(pattern => entry.name.includes(pattern))) : tests;
  let passed = 0;
  const failures = [];

  for (const entry of selected) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failures.push({ name: entry.name, error });
      console.log(`  ✗ ${entry.name}`);
      console.log(`      ${error.message.split('\n').join('\n      ')}`);
    }
  }

  console.log('');
  console.log(`${passed}/${selected.length} passed${failures.length ? `, ${failures.length} failed` : ''}`);
  if (failures.length) process.exitCode = 1;
})();
