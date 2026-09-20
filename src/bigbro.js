const fs = require('fs');
const path = require('path');
const os = require('os');
const yts = require('yt-search');
const ytdl = require('ytdl-core');

function jidFromNumber(value) { return `${String(value).replace(/\D/g, '')}@s.whatsapp.net`; }
function menuText(botName, prefix) { return `╭─〔 *${botName}* 〕─╮\n│ ${prefix}menu  ${prefix}ping  ${prefix}alive\n│ ${prefix}runtime  ${prefix}time\n│ ${prefix}music <song>\n│ ${prefix}antilink on|off\n│ ${prefix}antidelete on|off\n│ ${prefix}gclink on|off\n│ ${prefix}antikick on|off\n│ ${prefix}add 233...  ${prefix}kick @user\n│ ${prefix}kickall\n╰────────────────╯`; }

async function runBigBroCommand({ command, args, jid, message: m, reply, isGroup, groupSettings, saveSettings, isAdmin, botIsAdmin, groupMeta, targetUsers, socket, botName: BOT_NAME, prefix: PREFIX, STARTED, formatRuntime, mention }) {
  const moderate = async (action, users) => {
    if (!isGroup(jid)) return reply(m, 'This command only works in groups.');
    if (!(await isAdmin(jid, m.key.participant))) return reply(m, 'Only group admins can use this command.');
    if (!(await botIsAdmin(jid))) return reply(m, 'Please make DARKNOTE a group admin first.');
    if (!users.length) return reply(m, 'Mention a user or reply to their message.');
    await socket.groupParticipantsUpdate(jid, users, action);
    return reply(m, `Done: ${action} ${users.map(mention).join(', ')}`);
  };
  switch (command) {
    case 'menu': {
      const imagePath = path.join(process.cwd(), 'assets', 'menu.jpg');
      const content = fs.existsSync(imagePath) ? { image: fs.readFileSync(imagePath), caption: menuText(BOT_NAME, PREFIX) } : { text: menuText(BOT_NAME, PREFIX) };
      await socket.sendMessage(jid, content, { quoted: m });
      for (const button of ['ping', 'alive', 'time', 'music']) await socket.sendMessage(jid, { text: `◉ ${PREFIX}${button}` });
      return;
    }
    case 'ping': return reply(m, '🏓 Pong!');
    case 'runtime': return reply(m, `⏱️ Runtime: ${formatRuntime(Date.now() - STARTED)}`);
    case 'alive': return reply(m, `✅ ${BOT_NAME} is online.`);
    case 'time': return reply(m, `🕒 ${new Date().toLocaleString()}`);
    case 'music': {
      if (!args.length) return reply(m, `Usage: ${PREFIX}music <song name>`);
      const result = ytdl.validateURL(args.join(' ')) ? { videos: [{ url: args.join(' '), title: 'YouTube audio' }] } : await yts(args.join(' '));
      const video = result.videos?.[0]; if (!video) return reply(m, 'No music result found.');
      const file = path.join(os.tmpdir(), `darknote-${Date.now()}.mp3`);
      try { await reply(m, `⏳ Downloading: *${video.title}*`); await new Promise((resolve, reject) => ytdl(video.url, { quality: 'highestaudio', filter: 'audioonly' }).pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject)); await socket.sendMessage(jid, { audio: fs.readFileSync(file), mimetype: 'audio/mpeg', fileName: `${video.title.slice(0, 60)}.mp3` }, { quoted: m }); } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
      return;
    }
    case 'antilink': case 'antidelete': case 'gclink': case 'antikick': {
      if (!isGroup(jid) || !(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only, in a group.');
      if (!['on', 'off'].includes(args[0]?.toLowerCase())) return reply(m, `Usage: ${PREFIX}${command} on|off`);
      groupSettings(jid)[command] = args[0].toLowerCase() === 'on'; saveSettings(); return reply(m, `✅ ${command} is now ${args[0].toLowerCase()}.`);
    }
    case 'add': return moderate('add', args[0] ? [jidFromNumber(args[0])] : []);
    case 'kick': return moderate('remove', targetUsers(m));
    case 'kickall': { if (!isGroup(jid)) return reply(m, 'This command only works in groups.'); const users = (await groupMeta(jid)).participants.filter(p => !p.admin && p.id !== socket.user.id).map(p => p.id); return moderate('remove', users); }
    default: return reply(m, `Unknown command. Send ${PREFIX}menu for help.`);
  }
}
module.exports = { runBigBroCommand };
