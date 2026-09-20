const fs = require('fs');
const path = require('path');
const os = require('os');
const yts = require('yt-search');
const ytdl = require('ytdl-core');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

function jidFromNumber(value) { return `${String(value).replace(/\D/g, '')}@s.whatsapp.net`; }
function menuText(botName, prefix) { return `╭─〔 *${botName}* 〕─╮\n│ ${prefix}menu  ${prefix}ping  ${prefix}alive\n│ ${prefix}runtime  ${prefix}time\n│ ${prefix}music <song>  ${prefix}sticker\n│ ${prefix}anticall on|off  ${prefix}antimsg on|off\n│ ${prefix}antisticker on|off  ${prefix}antibot on|off\n│ ${prefix}autoblock on|off  ${prefix}block @user\n│ ${prefix}unblock @user\n│ ${prefix}antilink on|off  ${prefix}antidelete on|off\n│ ${prefix}gclink on|off  ${prefix}antikick on|off\n│ ${prefix}add 233...  ${prefix}kick @user  ${prefix}kickall\n╰────────────────╯`; }

async function runBigBroCommand({ command, args, jid, message: m, reply, isGroup, groupSettings, saveSettings, isAdmin, botIsAdmin, groupMeta, targetUsers, socket, botName: BOT_NAME, prefix: PREFIX, STARTED, formatRuntime, mention }) {
  const moderate = async (action, users) => {
    if (!isGroup(jid)) return reply(m, 'This command only works in groups.');
    if (!(await isAdmin(jid, m.key.participant))) return reply(m, 'Only group admins can use this command.');
    if (!(await botIsAdmin(jid))) return reply(m, 'Please make bigbrother edition a group admin first.');
    if (!users.length) return reply(m, 'Mention a user or reply to their message.');
    await socket.groupParticipantsUpdate(jid, users, action);
    return reply(m, `Done: ${action} ${users.map(mention).join(', ')}`);
  };
  const toggle = async name => {
    if (!isGroup(jid) || !(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only, in a group.');
    const value = args[0]?.toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(m, `Usage: ${PREFIX}${name} on|off`);
    groupSettings(jid)[name] = value === 'on'; saveSettings();
    return reply(m, `✅ ${name} is now ${value}.`);
  };
  const target = targetUsers(m);
  switch (command) {
    case 'menu': {
      const imagePath = path.join(process.cwd(), 'assets', 'menu.jpg');
      const content = fs.existsSync(imagePath) ? { image: fs.readFileSync(imagePath), caption: menuText(BOT_NAME, PREFIX) } : { text: menuText(BOT_NAME, PREFIX) };
      await socket.sendMessage(jid, content, { quoted: m });
      for (const button of ['ping', 'alive', 'time', 'music', 'sticker']) await socket.sendMessage(jid, { text: `◉ ${PREFIX}${button}` });
      return;
    }
    case 'ping': return reply(m, '🏓 Pong!');
    case 'runtime': return reply(m, `⏱️ Runtime: ${formatRuntime(Date.now() - STARTED)}`);
    case 'alive': return reply(m, `✅ ${BOT_NAME} is online.`);
    case 'time': return reply(m, `🕒 ${new Date().toLocaleString()}`);
    case 'anticall': return toggle('anticall');
    case 'antimsg': return toggle('antimsg');
    case 'antisticker': return toggle('antisticker');
    case 'antibot': return toggle('antibot');
    case 'autoblock': return toggle('autoblock');
    case 'antilink': case 'antidelete': case 'gclink': case 'antikick': return toggle(command);
    case 'block': {
      if (!(await isAdmin(jid, m.key.participant)) && isGroup(jid)) return reply(m, 'Admins only.');
      if (!target.length && !args[0]) return reply(m, `Mention, reply to, or provide a number: ${PREFIX}block 233...`);
      await socket.updateBlockStatus(target[0] || jidFromNumber(args[0]), 'block'); return reply(m, '🚫 User blocked.');
    }
    case 'unblock': {
      if (!(await isAdmin(jid, m.key.participant)) && isGroup(jid)) return reply(m, 'Admins only.');
      if (!target.length && !args[0]) return reply(m, `Mention, reply to, or provide a number: ${PREFIX}unblock 233...`);
      await socket.updateBlockStatus(target[0] || jidFromNumber(args[0]), 'unblock'); return reply(m, '✅ User unblocked.');
    }
    case 'sticker': {
      const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!m.message?.imageMessage && !quoted?.imageMessage) return reply(m, 'Reply to an image to make a sticker.');
      try {
        const media = await downloadMediaMessage({ key: m.key, message: m.message }, 'buffer', {});
        await socket.sendMessage(jid, { sticker: media }, { quoted: m });
      } catch (error) { console.error(error); return reply(m, 'Sticker failed. Please send or reply to a valid image.'); }
      return;
    }
    case 'music': {
      if (!args.length) return reply(m, `Usage: ${PREFIX}music <song name>`);
      const query = args.join(' '); const result = ytdl.validateURL(query) ? { videos: [{ url: query, title: 'YouTube audio' }] } : await yts(query); const video = result.videos?.[0];
      if (!video) return reply(m, 'No music result found.'); const file = path.join(os.tmpdir(), `bigbrother-${Date.now()}.mp3`);
      try { await reply(m, `⏳ Downloading: *${video.title}*`); await new Promise((resolve, reject) => ytdl(video.url, { quality: 'highestaudio', filter: 'audioonly' }).pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject)); await socket.sendMessage(jid, { audio: fs.readFileSync(file), mimetype: 'audio/mpeg', fileName: `${video.title.slice(0, 60)}.mp3` }, { quoted: m }); } catch (error) { console.error(error); return reply(m, 'Music download failed.'); } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
      return;
    }
    case 'add': return moderate('add', args[0] ? [jidFromNumber(args[0])] : []);
    case 'kick': return moderate('remove', target);
    case 'kickall': { if (!isGroup(jid)) return reply(m, 'This command only works in groups.'); const users = (await groupMeta(jid)).participants.filter(p => !p.admin && p.id !== socket.user.id).map(p => p.id); return moderate('remove', users); }
    default: return reply(m, `Unknown command. Send ${PREFIX}menu for help.`);
  }
}
module.exports = { runBigBroCommand };
