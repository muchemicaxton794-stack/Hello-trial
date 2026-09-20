require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
  jidDecode,
  getContentType,
  proto
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yts = require('yt-search');
const ytdl = require('ytdl-core');

const execFileAsync = promisify(execFile);
const PREFIX = process.env.PREFIX || '.';
const BOT_NAME = process.env.BOT_NAME || 'Hello Trial';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const STARTED = Date.now();
const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const settings = loadSettings();
const deletedCache = new Map();
let sock;

function loadSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function groupSettings(jid) { return settings[jid] ||= { antilink: false, antidelete: false, gclink: false, antikick: false }; }
function isGroup(jid) { return jid.endsWith('@g.us'); }
function numberFromJid(jid = '') { return jid.split('@')[0].split(':')[0]; }
function mention(jid) { return `@${numberFromJid(jid)}`; }
function formatRuntime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m ${s % 60}s`; }
function unwrapMessage(message) { return message?.ephemeralMessage?.message || message?.viewOnceMessage?.message || message; }
function textOf(msg) { const m = unwrapMessage(msg.message); return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || ''; }
function quoted(msg) { return unwrapMessage(msg.message)?.extendedTextMessage?.contextInfo?.quotedMessage; }
function mentionedJids(msg) { return unwrapMessage(msg.message)?.extendedTextMessage?.contextInfo?.mentionedJid || []; }
function jidFromMention(jid) { return jid && jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`; }
async function reply(m, text, extra = {}) { return sock.sendMessage(m.key.remoteJid, { text, ...extra }, { quoted: m }); }
async function groupMeta(jid) { return sock.groupMetadata(jid); }
async function admins(jid) { const meta = await groupMeta(jid); return meta.participants.filter(p => p.admin).map(p => p.id); }
async function isAdmin(jid, user) { return !isGroup(jid) || (await admins(jid)).includes(user); }
async function botIsAdmin(jid) { return isAdmin(jid, sock.user.id.split(':')[0] + '@s.whatsapp.net'); }
function menuText() { return `╭─〔 *${BOT_NAME}* 〕─╮\n│ Prefix: ${PREFIX}\n│\n│ ${PREFIX}menu\n│ ${PREFIX}ping\n│ ${PREFIX}runtime\n│ ${PREFIX}alive\n│ ${PREFIX}time\n│ ${PREFIX}music <song>\n│\n│ *Moderation*\n│ ${PREFIX}antilink on|off\n│ ${PREFIX}antidelete on|off\n│ ${PREFIX}gclink on|off\n│ ${PREFIX}antikick on|off\n│ ${PREFIX}add 233...\n│ ${PREFIX}kick @user\n│ ${PREFIX}kickall\n╰────────────────╯`; }
async function sendMenu(jid, m) {
  const imagePath = path.join(process.cwd(), 'assets', 'menu.jpg');
  const imageUrl = process.env.MENU_IMAGE_URL;
  const card = { caption: menuText() };
  if (fs.existsSync(imagePath)) card.image = fs.readFileSync(imagePath);
  else if (imageUrl) card.image = { url: imageUrl };
  else card.text = menuText();
  await sock.sendMessage(jid, card, { quoted: m });
  // Separate messages intentionally keep quick actions usable on clients that do not support old cards.
  for (const item of [`${PREFIX}ping`, `${PREFIX}alive`, `${PREFIX}music`, `${PREFIX}time`]) {
    await sock.sendMessage(jid, { text: `      ◉  ${item}` });
  }
}
async function targetUsers(m) {
  const ids = [...mentionedJids(m)];
  const q = quoted(m);
  if (q?.participant) ids.push(q.participant);
  return [...new Set(ids)];
}
async function moderate(m, action, users) {
  if (!isGroup(m.key.remoteJid)) return reply(m, 'This command only works in groups.');
  if (!(await isAdmin(m.key.remoteJid, m.key.participant))) return reply(m, 'Only group admins can use this command.');
  if (!(await botIsAdmin(m.key.remoteJid))) return reply(m, 'Please make me a group admin first.');
  if (!users.length) return reply(m, 'Mention a user or reply to their message.');
  await sock.groupParticipantsUpdate(m.key.remoteJid, users, action);
  return reply(m, `Done: ${action} ${users.map(mention).join(', ')}`);
}
async function music(m, query) {
  if (!query) return reply(m, `Usage: ${PREFIX}music <song name or YouTube URL>`);
  const result = ytdl.validateURL(query) ? { videos: [{ url: query, title: 'YouTube audio' }] } : await yts(query);
  const video = result.videos?.[0];
  if (!video) return reply(m, 'No music result found.');
  const file = path.join(os.tmpdir(), `hello-trial-${Date.now()}.mp3`);
  try {
    await reply(m, `⏳ Downloading: *${video.title}*`);
    await new Promise((resolve, reject) => ytdl(video.url, { quality: 'highestaudio', filter: 'audioonly' }).pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject));
    await sock.sendMessage(m.key.remoteJid, { audio: fs.readFileSync(file), mimetype: 'audio/mpeg', fileName: `${video.title.slice(0, 60)}.mp3` }, { quoted: m });
  } catch (e) { await reply(m, 'Music download failed. Try another search or URL.'); console.error(e.message); }
  finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
}
async function onMessage(m) {
  if (!m.message || m.key.fromMe) return;
  const jid = m.key.remoteJid;
  const text = textOf(m).trim();
  if (isGroup(jid) && /https?:\/\/(chat\.whatsapp\.com|whatsapp\.com\/channel)/i.test(text) && groupSettings(jid).antilink && !(await isAdmin(jid, m.key.participant))) {
    await sock.sendMessage(jid, { delete: m.key });
    return reply(m, '🚫 Group links are not allowed here.');
  }
  if (!text.startsWith(PREFIX)) return;
  const [raw, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = raw.toLowerCase();
  switch (command) {
    case 'menu': return sendMenu(jid, m);
    case 'ping': return reply(m, `🏓 Pong! ${Date.now() - (m.messageTimestamp * 1000 || Date.now())}ms`);
    case 'runtime': return reply(m, `⏱️ Runtime: ${formatRuntime(Date.now() - STARTED)}`);
    case 'alive': return reply(m, `✅ ${BOT_NAME} is online.\nRuntime: ${formatRuntime(Date.now() - STARTED)}`);
    case 'time': return reply(m, `🕒 ${new Date().toLocaleString()}`);
    case 'music': return music(m, args.join(' '));
    case 'antilink': case 'antidelete': case 'gclink': case 'antikick': {
      if (!isGroup(jid)) return reply(m, 'This command only works in groups.');
      if (!(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only.');
      const value = args[0]?.toLowerCase();
      if (!['on', 'off'].includes(value)) return reply(m, `Usage: ${PREFIX}${command} on|off`);
      groupSettings(jid)[command] = value === 'on'; saveSettings();
      return reply(m, `✅ ${command} is now ${value}.`);
    }
    case 'add': {
      if (!args[0]) return reply(m, `Usage: ${PREFIX}add 233000000000`);
      return moderate(m, 'add', [jidFromMention(args[0])]);
    }
    case 'kick': return moderate(m, 'remove', await targetUsers(m));
    case 'kickall': {
      if (!isGroup(jid) || !(await isAdmin(jid, m.key.participant))) return reply(m, 'Admins only, in a group.');
      const meta = await groupMeta(jid); const users = meta.participants.filter(p => !p.admin && p.id !== sock.user.id).map(p => p.id);
      return moderate(m, 'remove', users);
    }
    default: return reply(m, `Unknown command. Send ${PREFIX}menu for help.`);
  }
}
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), 'session'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) }, logger: P({ level: 'silent' }), printQRInTerminal: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: true });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log(`${BOT_NAME} connected as ${sock.user.id}`);
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) start();
  });
  sock.ev.on('messages.upsert', async ({ messages }) => { for (const m of messages) try { await onMessage(m); } catch (e) { console.error('message error:', e); } });
  sock.ev.on('messages.update', async updates => {
    for (const { key, update } of updates) if (update.message === null && isGroup(key.remoteJid) && groupSettings(key.remoteJid).antidelete) {
      const old = deletedCache.get(key.id); if (old) await sock.sendMessage(key.remoteJid, { text: `🗑️ Deleted by ${mention(old.key.participant)}:\n${textOf(old)}` });
    }
  });
  sock.ev.on('messages.upsert', ({ messages }) => messages.forEach(m => { if (m.key?.id) { deletedCache.set(m.key.id, m); setTimeout(() => deletedCache.delete(m.key.id), 10 * 60 * 1000); } }));
}
start().catch(console.error);
