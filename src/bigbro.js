async function runBigBroCommand({
  command,
  args,
  jid,
  m,
  reply,
  isGroup,
  groupSettings,
  isAdmin,
  botIsAdmin,
  sendMenu,
  music,
  moderate,
  groupMeta,
  sock,
  BOT_NAME,
  PREFIX,
  STARTED,
  targetUsers,
  jidFromMention,
  mention,
  formatRuntime
}) {
  switch (command) {
    case 'menu':
      return sendMenu(jid, m);

    case 'ping':
      return reply(m, `🏓 Pong! ${Date.now() - (m.messageTimestamp * 1000 || Date.now())}ms`);

    case 'runtime':
      return reply(m, `⏱️ Runtime: ${formatRuntime(Date.now() - STARTED)}`);

    case 'alive':
      return reply(m, `✅ ${BOT_NAME} is online.\nRuntime: ${formatRuntime(Date.now() - STARTED)}`);

    case 'time':
      return reply(m, `🕒 ${new Date().toLocaleString()}`);

    case 'music':
      return music(m, args.join(' '));

    case 'antilink':
    case 'antidelete':
    case 'gclink':
    case 'antikick': {
      if (!isGroup(jid)) return reply(m, 'This command only works in groups.');
      if (!(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only.');
      const value = args[0]?.toLowerCase();
      if (!['on', 'off'].includes(value)) return reply(m, `Usage: ${PREFIX}${command} on|off`);
      groupSettings(jid)[command] = value === 'on';
      const fs = require('fs');
      const path = require('path');
      const DATA_DIR = path.join(process.cwd(), 'data');
      const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings(jid), null, 2));
      return reply(m, `✅ ${command} is now ${value}.`);
    }

    case 'add': {
      if (!args[0]) return reply(m, `Usage: ${PREFIX}add 233000000000`);
      return moderate(m, 'add', [jidFromMention(args[0])]);
    }

    case 'kick':
      return moderate(m, 'remove', await targetUsers(m));

    case 'kickall': {
      if (!isGroup(jid) || !(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only, in a group.');
      const meta = await groupMeta(jid);
      const users = meta.participants.filter(p => !p.admin && p.id !== sock.user.id).map(p => p.id);
      return moderate(m, 'remove', users);
    }

    default:
      return reply(m, `Unknown command. Send ${PREFIX}menu for help.`);
  }
}

module.exports = { runBigBroCommand };
