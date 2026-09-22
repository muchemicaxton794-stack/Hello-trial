'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MUSIC_COOLDOWN_MS = 20000;
const MAX_AUDIO_SECONDS = 10 * 60;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // WhatsApp rejects larger media outright

const musicCooldowns = new Map();

/**
 * Menu content, grouped into the repeating blocks the decorated template is
 * built from. Entries are shown as written - a trailing "on|off" is part of the
 * usage, not decoration - and this list is also what the tests iterate, so a
 * command cannot be advertised without being wired up.
 */
const MENU_CATEGORIES = [
  { title: 'GENERAL', commands: ['menu', 'ping', 'alive', 'runtime', 'time'] },
  { title: 'MEDIA', commands: ['sticker', 'music <song|url>'] },
  {
    title: 'PROTECTION',
    commands: [
      'antilink on|off',
      'gclink on|off',
      'antidelete on|off',
      'antisticker on|off',
      'antimessage on|off',
      'antibot on|off',
      'antikick on|off',
      'autoblock on|off',
      'welcome on|off',
      'goodbye on|off'
    ]
  },
  {
    title: 'GROUP ADMIN',
    commands: [
      'add <number>',
      'kick @user',
      'kickall',
      'promote @user',
      'demote @user',
      'tagall [text]',
      'hidetag [text]',
      'groupinfo',
      'resetlink',
      'setname <text>',
      'setdesc <text>',
      'resetgroup'
    ]
  },
  {
    title: 'OWNER',
    commands: ['block', 'unblock', 'anticall on|off', 'mode self|public', 'addsudo', 'delsudo', 'owner']
  }
];

/** Visible characters per line, ignoring the WhatsApp formatting markers. */
const MENU_WRAP_WIDTH = 34;

const HEADER = title => `╭━≫〖 *${title}* 〗≪━╮`;
const BLOCK_TOP = '┇ ╭────↯';
const BLOCK_BOTTOM = "┇ ╰────↯'";
const BLOCK_CLOSE = '┗━━━━━━━━━━━━━━━━━━〣';
const BLOCK_DIVIDER = '  ━━━━━━━━━━━━━━━━━━';

/**
 * Packs a category's commands into `_\`command\`_` lines, wrapping before the
 * line grows past MENU_WRAP_WIDTH so nothing gets reflowed by the client.
 */
function packMenuCommands(commands, width = MENU_WRAP_WIDTH) {
  const lines = [];
  let current = '';

  for (const command of commands) {
    const piece = `_\`${command}\`_`;
    if (!current) {
      current = piece;
      continue;
    }
    if (current.replace(/[`_]/g, '').length + 2 + command.length > width) {
      lines.push(current);
      current = piece;
    } else {
      current += `  ${piece}`;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function menuBlock(category) {
  return [
    BLOCK_TOP,
    `┇ │ _\`${category.title}\`_`,
    '┇ │ ',
    ...packMenuCommands(category.commands).map(line => `┇ │  ${line}`),
    BLOCK_BOTTOM,
    BLOCK_CLOSE
  ].join('\n');
}

/**
 * The decorated menu. The prefix is deliberately absent from the body so the
 * blocks stay clean - every entry reads as a bare command, matching the design.
 */
function menuText(title, prefix, categories = MENU_CATEGORIES) {
  void prefix;
  return [HEADER(title), categories.map(menuBlock).join(`\n${BLOCK_DIVIDER}\n`)].join('\n');
}

/**
 * Maps a YouTube audio-only format to something WhatsApp will accept.
 * The container matters: sending Opus/WebM bytes as `audio/mpeg` (as an earlier
 * revision did) produces a file WhatsApp cannot play.
 */
function audioKindOf(format) {
  const mime = String(format?.mimeType || '').toLowerCase();
  const container = String(format?.container || '').toLowerCase();
  // The container decides; the codecs= parameter must not, or an Opus-in-WebM
  // stream gets mislabelled as Ogg.
  if (mime.includes('webm') || container.includes('webm')) {
    return { mimetype: 'audio/webm', extension: 'weba' };
  }
  if (mime.includes('mp4') || mime.includes('m4a') || container.includes('mp4') || container.includes('m4a')) {
    return { mimetype: 'audio/mp4', extension: 'm4a' };
  }
  if (mime.includes('ogg') || mime.includes('opus') || container.includes('ogg') || container.includes('opus')) {
    return { mimetype: 'audio/ogg', extension: 'ogg' };
  }
  return { mimetype: 'application/octet-stream', extension: 'bin' };
}

async function runBigBroCommand(tools) {
  const {
    command,
    args,
    jid,
    message: m,
    reply,
    isGroup,
    isOwner,
    isGroupAdmin,
    botIsAdmin,
    groupMeta,
    targetUsers,
    socket,
    botName,
    prefix,
    startedAt,
    formatRuntime,
    mention,
    downloadMedia,
    isStickerSource,
    sameUser,
    toPhoneJid,
    groupSettings,
    saveSettings,
    resetSettings,
    settingsStore,
    ownersStore,
    globalStore,
    expectRemoval,
    spamManager = null,
    spamProtection = null,
    debug = { log: () => {} },
    mode = 'self',
    warn = console.warn
  } = tools;

  // BUG FIX: a message sent by the linked account (`fromMe`) was attributed to
  // the *other* party, i.e. the remote chat. In `self` mode that meant the owner
  // was denied their own commands in any DM that was not the self-chat. The
  // linked account is always the author of its own messages.
  const sender = m.key.participant || (m.key.fromMe ? socket.user?.id : m.key.remoteJid);
  const inGroup = isGroup(jid);
  const owner = await isOwner(sender);

  // In self mode the bot answers nobody but its owners. Stay silent rather than
  // replying, so the bot does not advertise itself to strangers.
  if (mode === 'self' && !owner) return undefined;

  const json = (value, spacing = 2) => JSON.stringify(value, null, spacing);

  const groupOnly = async () => {
    if (inGroup) return true;
    await reply(m, 'This command only works in groups.');
    return false;
  };

  const adminOnly = async () => {
    if (!(await groupOnly())) return false;
    if (!(await isGroupAdmin(jid, sender))) {
      await reply(m, 'Only group admins can use this command.');
      return false;
    }
    if (!(await botIsAdmin(jid))) {
      await reply(m, `Please make ${botName} a group admin first.`);
      return false;
    }
    return true;
  };

  const ownerOnly = async () => {
    if (owner) return true;
    await reply(m, 'Only the bot owner can use this command.');
    return false;
  };

  /** Reads the real SpamManager settings, so `status` cannot disagree with them. */
  const spamDescribe = () => {
    if (!spamManager) return ['⚠️ spam detector not initialised'];
    return [
      `◈ window: ${spamManager.windowSeconds}s`,
      `◈ flood limit: ${spamManager.messageLimit} messages`,
      `◈ actions: ${spamManager.actions.join(' + ') || 'none'}`,
      spamManager.unknownActions.length ? `⚠️ unknown actions ignored: ${spamManager.unknownActions.join(', ')}` : null
    ].filter(Boolean);
  };

  const stickerDescribe = () => [
    '◈ deletes stickerMessage only',
    '◈ images, videos, GIFs and documents are untouched'
  ];

  const toggle = async (name, { scope = 'group', describe } = {}) => {
    if (scope === 'owner') {
      if (!(await ownerOnly())) return undefined;
    } else if (!(await adminOnly())) {
      return undefined;
    }
    const value = String(args[0] || '').toLowerCase();

    // §8/§9: on | off | status. "status" reports the *effective* configuration,
    // including the real thresholds, so nothing has to be taken on trust.
    if (value === 'status') {
      const current = scope === 'owner' ? Boolean(globalStore.get(name)) : Boolean(groupSettings(jid)[name]);
      const details = typeof describe === 'function' ? describe(jid, current) : [];
      await reply(m, [`${current ? '🟢' : '🔴'} ${name}: ${current ? 'ON' : 'OFF'}`, ...details].join('\n'));
      return undefined;
    }

    if (!['on', 'off'].includes(value)) {
      await reply(m, `Usage: ${prefix}${name} on|off|status`);
      return undefined;
    }
    if (scope === 'owner') {
      globalStore.set(name, value === 'on');
    } else {
      groupSettings(jid)[name] = value === 'on';
      saveSettings();
    }
    const details = typeof describe === 'function' ? describe(jid, value === 'on') : [];
    await reply(m, [`✅ ${name} is now ${value}.`, ...details].join('\n'));
    return undefined;
  };

  /**
   * add/remove/promote/demote with the permission and bot-admin preconditions.
   * Removals the bot performs are registered first so antikick cannot undo the
   * owner's own moderation.
   */
  /**
   * Translates LID targets to phone numbers. WhatsApp's group and blocklist APIs
   * reject LIDs with a bare "bad-request", so anything that cannot be translated
   * is reported instead of being sent and failing opaquely.
   */
  const resolveUsers = users => {
    const resolved = [];
    const unknownLids = [];
    for (const user of users) {
      const phone = toPhoneJid ? toPhoneJid(user) : user;
      if (phone) resolved.push(phone);
      else unknownLids.push(user);
    }
    return { resolved: [...new Set(resolved)], unknownLids };
  };

  const moderate = async (action, users) => {
    if (!(await adminOnly())) return undefined;
    if (!users.length) {
      await reply(m, 'Mention a user, reply to their message, or pass a number.');
      return undefined;
    }

    const { resolved: targets, unknownLids } = resolveUsers(users);
    if (unknownLids.length) {
      await reply(
        m,
        `⚠️ No phone number known for ${unknownLids.map(mention).join(', ')} - WhatsApp only accepts ` +
          'phone numbers here. Pass the number explicitly if the action matters.'
      );
      if (!targets.length) return undefined;
    }

    if (action === 'remove') expectRemoval(jid, targets);
    try {
      const result = await socket.groupParticipantsUpdate(jid, targets, action);
      const failed = (result || []).filter(entry => entry?.status && entry.status !== '200');
      if (failed.length) {
        await reply(m, `⚠️ WhatsApp rejected ${failed.length} of ${targets.length}: ${json(failed)}`);
      }
      await reply(m, `✅ ${action}: ${targets.map(mention).join(', ')}`);
    } catch (error) {
      warn(`[command] ${action} failed: ${error?.message || error}`);
      await reply(m, `❌ ${action} failed: ${error?.message || error}`);
    }
    return undefined;
  };

  const target = targetUsers(m);

  switch (command) {
    case 'menu': {
      const text = menuText(tools.menuTitle || botName, prefix);
      // BUG FIX: the README promised a MENU_IMAGE_URL fallback that the code never
      // read, and the path was resolved from process.cwd(), so the local image was
      // missed whenever the bot was started from another directory.
      const local = tools.menuImagePath || path.join(process.cwd(), 'assets', 'menu.jpg');
      const remote = tools.menuImageUrl;
      try {
        if (fs.existsSync(local)) {
          await socket.sendMessage(jid, { image: fs.readFileSync(local), caption: text }, { quoted: m });
        } else if (remote) {
          await socket.sendMessage(jid, { image: { url: remote }, caption: text }, { quoted: m });
        } else {
          await socket.sendMessage(jid, { text }, { quoted: m });
        }
      } catch (error) {
        warn(`[menu] falling back to text: ${error?.message || error}`);
        await reply(m, text);
      }
      // The old build followed the menu with one extra message per quick command
      // ("◉ .ping", "◉ .alive", ...). That is five more notifications after an
      // already long menu, so the commands live in the blocks instead.
      return undefined;
    }

    case 'ping':
      return reply(m, '🏓 Pong!');

    case 'runtime':
      return reply(m, `⏱️ Runtime: ${formatRuntime(Date.now() - startedAt)}`);

    case 'alive':
      return reply(m, `✅ ${botName} is online (${mode} mode).`);

    case 'time':
      return reply(m, `🕒 ${new Date().toLocaleString()}`);

    case 'sticker': {
      // BUG FIX: the quoted image is validated *and* downloaded. Previously the
      // code checked the quoted image but downloaded the command text message,
      // so replying to an image always failed.
      const context = m.message?.extendedTextMessage?.contextInfo;
      const quoted = context?.quotedMessage;
      let source = null;

      // isStickerSource() only accepts image/video/sticker - never the plain
      // "conversation" content of the command message itself.
      if (quoted && isStickerSource({ message: quoted })) {
        source = {
          key: { remoteJid: jid, id: context.stanzaId, fromMe: false, participant: context.participant },
          message: quoted
        };
      } else if (isStickerSource(m)) {
        source = m;
      }

      if (!source) {
        await reply(m, `Send an image with the caption *${prefix}sticker*, or reply to an image with *${prefix}sticker*.`);
        return undefined;
      }

      try {
        const media = await downloadMedia(source);
        await socket.sendMessage(jid, { sticker: media }, { quoted: m });
      } catch (error) {
        warn(`[sticker] ${error?.message || error}`);
        await reply(m, 'Sticker failed. Please send or reply to a valid image.');
      }
      return undefined;
    }

    case 'music': {
      if (!args.length) {
        await reply(m, `Usage: ${prefix}music <song name or YouTube URL>`);
        return undefined;
      }

      const now = Date.now();
      const last = musicCooldowns.get(sender) || 0;
      if (now - last < MUSIC_COOLDOWN_MS) {
        await reply(m, `⏳ Please wait ${Math.ceil((MUSIC_COOLDOWN_MS - (now - last)) / 1000)}s before the next track.`);
        return undefined;
      }

      let ytdl;
      let yts;
      try {
        ytdl = require('@distube/ytdl-core');
        yts = require('yt-search');
      } catch (error) {
        await reply(m, `Music module unavailable: ${error?.message || error}`);
        return undefined;
      }

      musicCooldowns.set(sender, now);
      const query = args.join(' ');

      try {
        const url = ytdl.validateURL(query) ? query : (await yts(query)).videos?.[0]?.url;
        if (!url) {
          await reply(m, 'No music result found.');
          return undefined;
        }

        const info = await ytdl.getInfo(url);
        const seconds = Number(info.videoDetails?.lengthSeconds || 0);
        if (seconds > MAX_AUDIO_SECONDS) {
          await reply(m, `That track is ${Math.round(seconds / 60)} min long; the limit is ${MAX_AUDIO_SECONDS / 60} min.`);
          return undefined;
        }

        const audioFormats = (info.formats || []).filter(format => format.hasAudio && !format.hasVideo);
        const chosen = ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });
        const kind = audioKindOf(chosen);
        const title = info.videoDetails?.title || 'audio';

        await reply(m, `⏳ Downloading: *${title}*`);

        const file = path.join(os.tmpdir(), `bigbrother-${process.pid}-${Date.now()}.${kind.extension}`);
        try {
          await new Promise((resolve, reject) => {
            let written = 0;
            const stream = ytdl.downloadFromInfo(info, { format: chosen });
            const out = fs.createWriteStream(file);
            stream.on('data', chunk => {
              written += chunk.length;
              if (written > MAX_AUDIO_BYTES) stream.destroy(new Error('audio exceeds the size cap'));
            });
            stream.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            stream.pipe(out);
          });

          const buffer = fs.readFileSync(file);
          if (kind.mimetype === 'application/octet-stream') {
            await socket.sendMessage(jid, { document: buffer, mimetype: kind.mimetype, fileName: `${title.slice(0, 60)}.${kind.extension}` }, { quoted: m });
          } else {
            await socket.sendMessage(jid, { audio: buffer, mimetype: kind.mimetype, fileName: `${title.slice(0, 60)}.${kind.extension}`, ptt: false }, { quoted: m });
          }
        } finally {
          fs.rmSync(file, { force: true });
        }
      } catch (error) {
        warn(`[music] ${error?.message || error}`);
        await reply(m, `Music download failed: ${error?.message || error}`);
      }
      return undefined;
    }

    case 'anticall':
      return toggle('anticall', { scope: 'owner' });

    case 'antimessage':
      // The old spelling keeps working: a group may already have it configured
      // and muscle memory outlives a rename.
      return toggle('antimessage', { describe: spamDescribe });

    case 'antimsg':
      return toggle('antimessage', { describe: spamDescribe });

    case 'antisticker':
      return toggle('antisticker', { describe: stickerDescribe });

    case 'autoblock':
      return toggle('autoblock', { describe: spamDescribe });

    case 'antilink':
    case 'antidelete':
    case 'antibot':
    case 'antikick':
    case 'welcome':
    case 'goodbye':
    case 'gclink':
      return toggle(command);

    case 'resetgroup': {
      if (!(await adminOnly())) return undefined;
      resetSettings(jid);
      return reply(m, '♻️ Group settings reset to defaults.');
    }

    case 'block':
    case 'unblock': {
      if (!(await ownerOnly())) return undefined;
      const raw = args[0];
      const digits = raw ? String(raw).replace(/\D/g, '') : '';
      if (!target.length && digits.length < 8) {
        return reply(m, `Mention a user, reply to their message, or pass a number: ${prefix}${command} <number>`);
      }
      const candidate = target[0] || `${digits}@s.whatsapp.net`;
      // The blocklist API needs a phone-number JID; a LID returns "bad-request".
      const user = toPhoneJid ? toPhoneJid(candidate) : candidate;
      if (!user) {
        return reply(
          m,
          `⚠️ ${mention(candidate)} is only known to me by LID, and WhatsApp's blocklist needs a phone ` +
            `number. Try: ${prefix}${command} 2547...`
        );
      }
      try {
        await socket.updateBlockStatus(user, command);
        return reply(m, command === 'block' ? `🚫 ${mention(user)} blocked.` : `✅ ${mention(user)} unblocked.`);
      } catch (error) {
        return reply(m, `❌ ${command} failed: ${error?.message || error}`);
      }
    }

    case 'owner': {
      if (!(await ownerOnly())) return undefined;
      const extra = ownersStore ? ownersStore.get('owners') || [] : [];
      return reply(
        m,
        [
          `👑 paired account: ${mention(socket.user?.id || '')}`,
          `sudo list: ${extra.length ? extra.map(entry => mention(entry)).join(', ') : '(empty)'}`
        ].join('\n'),
        { mentions: [socket.user?.id, ...extra].filter(Boolean) }
      );
    }

    case 'addsudo':
    case 'delsudo': {
      if (!(await ownerOnly())) return undefined;
      const raw = args[0];
      const digits = raw ? String(raw).replace(/\D/g, '') : '';
      const user = target[0] || (digits.length >= 8 ? `${digits}@s.whatsapp.net` : null);
      if (!user) return reply(m, `Usage: ${prefix}${command} @user or ${prefix}${command} <number>`);

      const list = new Set((ownersStore.get('owners') || []).map(entry => String(entry).split('@')[0].split(':')[0]));
      if (command === 'addsudo') list.add(String(user).split('@')[0].split(':')[0]);
      else list.delete(String(user).split('@')[0].split(':')[0]);
      ownersStore.set('owners', [...list]);
      return reply(m, `✅ sudo list: ${[...list].map(entry => `+${entry}`).join(', ') || '(empty)'}`);
    }

    case 'mode': {
      if (!(await ownerOnly())) return undefined;
      const value = String(args[0] || '').toLowerCase();
      if (!['self', 'public'].includes(value)) return reply(m, `Usage: ${prefix}mode self|public`);
      globalStore.set('mode', value);
      tools.setMode?.(value);
      return reply(m, `✅ mode is now ${value}. This persists in data/global.json.`);
    }

    case 'add': {
      const digitString = args[0] ? String(args[0]).replace(/\D/g, '') : '';
      if (digitString.length < 8) {
        await reply(m, `Usage: ${prefix}add <number> (full international number, no "+")`);
        return undefined;
      }
      return moderate('add', [`${digitString}@s.whatsapp.net`]);
    }

    case 'kick':
      return moderate('remove', target);

    case 'promote':
      return moderate('promote', target);

    case 'demote':
      return moderate('demote', target);

    case 'kickall': {
      if (!inGroup) {
        await reply(m, 'This command only works in groups.');
        return undefined;
      }
      if (!(await adminOnly())) return undefined;
      const meta = await groupMeta(jid);
      const sudo = ownersStore.get('owners') || [];
      // BUG FIX: the bot's own JID is compared with sameUser(), so a device
      // suffix ("1234:5@s.whatsapp.net") can no longer defeat the self-exclusion
      // and make the bot try to remove itself.
      const users = (meta?.participants || [])
        .filter(participant => !participant.admin)
        .filter(participant => !sameUser(participant.id, socket.user?.id))
        .filter(participant => !sudo.some(entry => sameUser(entry, participant.id)))
        .map(participant => participant.id);
      return moderate('remove', users);
    }

    case 'tagall':
    case 'hidetag': {
      if (!(await adminOnly())) return undefined;
      const meta = await groupMeta(jid);
      const users = (meta?.participants || []).map(participant => participant.id);
      if (!users.length) return reply(m, 'No participants found.');
      const note = args.join(' ').trim() || '📣 Attention everyone';
      if (command === 'tagall') {
        return socket.sendMessage(jid, { text: `${note}\n\n${users.map(mention).join('\n')}`, mentions: users });
      }
      return socket.sendMessage(jid, { text: note, mentions: users });
    }

    case 'groupinfo': {
      if (!(await groupOnly())) return undefined;
      const meta = await groupMeta(jid);
      const participants = meta?.participants || [];
      const admins = participants.filter(participant => participant.admin);
      return reply(
        m,
        [
          `📋 *${meta?.subject || jid}*`,
          `id: ${jid}`,
          `members: ${participants.length} (admins: ${admins.length})`,
          meta?.creation ? `created: ${new Date(meta.creation * 1000).toLocaleString()}` : null,
          meta?.desc ? `description: ${meta.desc}` : null
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    case 'resetlink': {
      if (!(await adminOnly())) return undefined;
      const code = await socket.groupRevokeInvite(jid);
      if (!code) return reply(m, '❌ Could not revoke the invite link.');
      return reply(m, `🔗 New invite link: https://chat.whatsapp.com/${code}`);
    }

    case 'setname': {
      if (!(await adminOnly())) return undefined;
      const name = args.join(' ').trim();
      if (!name) return reply(m, `Usage: ${prefix}setname <new group name>`);
      await socket.groupUpdateSubject(jid, name);
      return reply(m, '✅ Group name updated.');
    }

    case 'setdesc': {
      if (!(await adminOnly())) return undefined;
      const desc = args.join(' ').trim();
      await socket.groupUpdateDescription(jid, desc);
      return reply(m, desc ? '✅ Group description updated.' : '✅ Group description cleared.');
      }

    default:
      return reply(m, `Unknown command. Send ${prefix}menu for help.`);
  }
}

module.exports = { runBigBroCommand, menuText, menuBlock, packMenuCommands, MENU_CATEGORIES, audioKindOf };
