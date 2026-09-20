const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STARTED = Date.now();
const deletedMessages = new Map();
const recentMessages = new Map();
const settings = loadSettings();

function loadSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function groupSettings(jid) {
  return settings[jid] ||= {
    antilink: false, antidelete: false, gclink: false, antikick: false,
    antimsg: false, antisticker: false, antibot: false, autoblock: false
  };
}
function unwrap(message) { return message?.ephemeralMessage?.message || message?.viewOnceMessage?.message || message; }
function bodyOf(message) { return unwrap(message?.message); }
function textOf(message) {
  const body = bodyOf(message);
  return body?.conversation || body?.extendedTextMessage?.text || body?.imageMessage?.caption || body?.videoMessage?.caption || '';
}
function parseCommand(message) {
  const text = textOf(message).trim();
  if (!text.startsWith(this.prefix)) return null;
  const [raw, ...args] = text.slice(this.prefix.length).trim().split(/\s+/);
  return raw ? { command: raw.toLowerCase(), args, jid: message.key.remoteJid, message } : null;
}
function numberOf(jid = '') { return jid.split('@')[0].split(':')[0]; }
function mention(jid) { return `@${numberOf(jid)}`; }
function isGroup(jid = '') { return jid.endsWith('@g.us'); }
function formatRuntime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m ${s % 60}s`; }
function mentioned(message) { return bodyOf(message)?.extendedTextMessage?.contextInfo?.mentionedJid || []; }
function quotedParticipant(message) { return bodyOf(message)?.extendedTextMessage?.contextInfo?.participant; }
function isSticker(message) { return Boolean(bodyOf(message)?.stickerMessage); }
function isBotLike(message) { return Boolean(message?.key?.remoteJid?.endsWith('@newsletter') || bodyOf(message)?.protocolMessage); }
function groupLink(text) { return /https?:\/\/(chat\.whatsapp\.com|whatsapp\.com\/channel)/i.test(text); }

function createMessageTools({ socket, botName, prefix }) {
  const tools = { socket, botName, prefix, STARTED, settings, groupSettings, saveSettings, isGroup, mention, formatRuntime, textOf, isSticker };
  tools.reply = (message, text, extra = {}) => socket.sendMessage(message.key.remoteJid, { text, ...extra }, { quoted: message });
  tools.parseCommand = parseCommand.bind(tools);
  tools.remember = async message => {
    if (!message.key?.id) return;
    deletedMessages.set(message.key.id, message);
    setTimeout(() => deletedMessages.delete(message.key.id), 600000);
  };
  tools.restoreDeleted = async key => {
    const old = deletedMessages.get(key.id);
    if (old && isGroup(key.remoteJid) && groupSettings(key.remoteJid).antidelete) {
      await socket.sendMessage(key.remoteJid, { text: `🗑️ Deleted message by ${mention(old.key.participant)}:\n${textOf(old) || '[media]'}` });
    }
  };
  tools.isAdmin = async (jid, user) => !isGroup(jid) || (await socket.groupMetadata(jid)).participants.some(p => p.id === user && p.admin);
  tools.botIsAdmin = async jid => tools.isAdmin(jid, socket.user.id.split(':')[0] + '@s.whatsapp.net');
  tools.groupMeta = jid => socket.groupMetadata(jid);
  tools.targetUsers = message => [...new Set([...mentioned(message), quotedParticipant(message)].filter(Boolean))];

  // Group safety middleware. It returns true when the message was handled.
  tools.handleProtection = async message => {
    const jid = message.key.remoteJid;
    if (!isGroup(jid) || message.key.fromMe) return false;
    const config = groupSettings(jid);
    const text = textOf(message);
    const sender = message.key.participant;
    const admin = await tools.isAdmin(jid, sender);
    if (admin) return false;

    if (config.antibot && isBotLike(message)) {
      await socket.sendMessage(jid, { delete: message.key });
      return true;
    }
    if (config.antisticker && isSticker(message)) {
      await socket.sendMessage(jid, { delete: message.key });
      return true;
    }
    if (config.antimsg && text && /(.)\1{8,}|https?:\/\/|wa\.me\//i.test(text)) {
      await socket.sendMessage(jid, { delete: message.key });
      return true;
    }
    if (config.antilink && groupLink(text)) {
      await socket.sendMessage(jid, { delete: message.key });
      return true;
    }
    if (config.autoblock && text) {
      const now = Date.now();
      const history = recentMessages.get(`${jid}:${sender}`) || [];
      const next = [...history.filter(item => now - item.time < 15000), { text: text.toLowerCase(), time: now }];
      recentMessages.set(`${jid}:${sender}`, next);
      const repeated = next.filter(item => item.text === text.toLowerCase()).length >= 4;
      if (repeated || next.length >= 8) {
        await socket.sendMessage(jid, { delete: message.key });
        try { await socket.updateBlockStatus(sender, 'block'); } catch (error) { console.error('autoblock:', error.message); }
        return true;
      }
    }
    return false;
  };
  return tools;
}
module.exports = { createMessageTools, textOf, groupSettings };
