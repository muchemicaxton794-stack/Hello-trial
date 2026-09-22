'use strict';

const path = require('path');

// .env is resolved relative to the project root so the bot behaves the same
// no matter which directory it is launched from.
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dotenvVars = dotenvResult.parsed || {};

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_DIR = path.join(ROOT, 'session');
const ASSETS_DIR = path.join(ROOT, 'assets');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const STATUS_DOWNLOAD_DIR = path.join(DOWNLOADS_DIR, 'status');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json');
const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
const STATUS_DB_FILE = path.join(DATA_DIR, 'status-events.json');
const QR_FILE = path.join(DATA_DIR, 'qr.txt');
const MENU_IMAGE_PATH = path.join(ASSETS_DIR, 'menu.jpg');

const digits = value => String(value ?? '').replace(/\D/g, '');

function numberOr(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

// Documented placeholders from .env.example must never be treated as a real
// owner number, otherwise a random account would own the bot.
const PLACEHOLDER_NUMBERS = new Set(['233000000000', '1234567890', '0000000000', '123456789']);

const rawOwner = digits(process.env.OWNER_NUMBER);
const OWNER_NUMBER = PLACEHOLDER_NUMBERS.has(rawOwner) ? '' : rawOwner;

const rawPairing = digits(process.env.PAIRING_NUMBER);
const PAIRING_NUMBER = PLACEHOLDER_NUMBERS.has(rawPairing) ? '' : rawPairing;

// Optional chosen pairing code. Baileys requires exactly 8 characters, so an
// invalid value is dropped with a warning rather than throwing mid-pairing.
const rawPairingCode = (process.env.PAIRING_CODE || '').trim();
const PAIRING_CODE = rawPairingCode.length === 8 ? rawPairingCode : '';

const PREFIX = (process.env.PREFIX || '.').trim() || '.';
const BOT_NAME = (process.env.BOT_NAME || 'bigbrother edition').trim() || 'bigbrother edition';

// Title shown in the menu header. Kept separate from BOT_NAME so the decorated
// menu can carry a stylised name (unicode script glyphs, emoji, spacing) without
// those characters leaking into logs and ordinary replies.
const MENU_TITLE = (process.env.MENU_TITLE || '').trim() || BOT_NAME;
const MENU_IMAGE_URL = (process.env.MENU_IMAGE_URL || '').trim();

const requestedMode = String(process.env.MODE || '').trim().toLowerCase();
const MODE = requestedMode === 'public' ? 'public' : 'self';

// DM sent to the paired number the moment a new device is linked.
// Blank means "use the built-in copy" (see src/welcome.js).
const PAIR_WELCOME = String(process.env.PAIRING_WELCOME || '').trim();

// -- centralized time zone (src/time.js) -------------------------------------
// Priority: BOT_TIMEZONE (process env) -> BOT_TIMEZONE (.env) -> TIMEZONE (.env)
// -> "auto".
//
// The ambient process TIMEZONE is deliberately NOT read. Hosts and orchestrators
// set TIMEZONE for their own purposes (this one exports Asia/Shanghai), and
// dotenv never overrides an already-set variable, so reading it would let an
// unrelated platform setting silently take over every timestamp in the bot.
// Use BOT_TIMEZONE to override from the shell.
const TIMEZONE =
  (process.env.BOT_TIMEZONE || '').trim() ||
  (dotenvVars.BOT_TIMEZONE || '').trim() ||
  (dotenvVars.TIMEZONE || '').trim() ||
  'auto';

// -- automatic spam protection (src/spam.js) ---------------------------------
const SPAM_WINDOW_SECONDS = numberOr(process.env.SPAM_WINDOW, 10);
const SPAM_MESSAGE_LIMIT = numberOr(process.env.SPAM_MESSAGE_LIMIT, 6);
// delete | warn | kick | block, or a "+" combination such as delete+warn
const SPAM_ACTION = (process.env.SPAM_ACTION || 'delete+warn').trim().toLowerCase();
const SPAM_WARN_LIMIT = numberOr(process.env.SPAM_WARN_LIMIT, 2);

// -- debug logging (src/debug-log.js) ----------------------------------------
// §36: one line per automatic action, timestamped in the configured zone.
const DEBUG_LOG = String(process.env.DEBUG_LOG || 'true').toLowerCase() !== 'false';

// -- protected users (src/protected.js) --------------------------------------
// Never automatically punished: blocked, kicked, banned, demoted or warned.
const PROTECTED_USERS = list(process.env.PROTECTED_USERS).map(digits).filter(Boolean);

// -- reactions (src/reactions.js) -------------------------------------------
const REACTION_POOL = list(
  process.env.REACTION_POOL || '❤️,😂,😮,😢,🔥,👏,😍,👍,🙏,💯,✨'
);

// -- status automation (src/status.js) --------------------------------------
// Where PUBLIC mode sends processed status media. Blank means the status owner.
const AUTOSTATUS_DESTINATION = String(process.env.AUTOSTATUS_DESTINATION || '').trim();
const STATUS_IGNORE = list(process.env.STATUS_IGNORE);
const STATUS_FILTER_MODE = ['all', 'whitelist', 'custom'].includes(
  String(process.env.STATUS_FILTER_MODE || '').trim().toLowerCase()
)
  ? String(process.env.STATUS_FILTER_MODE).trim().toLowerCase()
  : 'all';
const STATUS_WHITELIST = list(process.env.STATUS_WHITELIST);
const STATUS_DEDUP_TTL_HOURS = numberOr(process.env.STATUS_DEDUP_TTL_HOURS, 24);
const STATUS_MAX_MEDIA_BYTES = numberOr(process.env.STATUS_MAX_MEDIA_BYTES, 16 * 1024 * 1024);

// -- music (src/music.js) ----------------------------------------------------
const MUSIC_RESULT_COUNT = numberOr(process.env.MUSIC_RESULT_COUNT, 5);
const MUSIC_MAX_SECONDS = numberOr(process.env.MUSIC_MAX_SECONDS, 10 * 60);
const MUSIC_MAX_BYTES = numberOr(process.env.MUSIC_MAX_BYTES, 15 * 1024 * 1024);
const MUSIC_YTDLP_ENDPOINT = String(process.env.MUSIC_YTDLP_ENDPOINT || '').trim();

/**
 * Reports misconfiguration without crashing the boot: a bot that refuses to
 * start is harder to debug than one that starts and says what is wrong.
 */
function validate() {
  const warnings = [];

  if (!OWNER_NUMBER) {
    warnings.push(
      'OWNER_NUMBER is not set (or is still the .env.example placeholder). ' +
        'Owner-only commands will work only from the paired account.'
    );
  } else if (OWNER_NUMBER.length < 8) {
    warnings.push(`OWNER_NUMBER "${OWNER_NUMBER}" looks too short; use full international digits without "+".`);
  }

  if (PAIRING_NUMBER && PAIRING_NUMBER.length < 8) {
    warnings.push(`PAIRING_NUMBER "${PAIRING_NUMBER}" looks too short; use full international digits without "+".`);
  }

  if (rawPairingCode && !PAIRING_CODE) {
    warnings.push(
      `PAIRING_CODE "${rawPairingCode}" is ${rawPairingCode.length} characters; WhatsApp requires exactly 8. ` +
        'A random code will be used instead.'
    );
  }

  if (PAIRING_CODE && !PAIRING_NUMBER) {
    warnings.push('PAIRING_CODE is set but PAIRING_NUMBER is not, so no pairing code will be requested.');
  }

  if (!PAIRING_NUMBER && !process.stdout.isTTY) {
    warnings.push(
      `No PAIRING_NUMBER and stdout is not a terminal: the QR code will be written to ${path.relative(ROOT, QR_FILE)} ` +
        'instead of being drawn in the console.'
    );
  }

  if (MODE === 'self') {
    warnings.push('MODE=self: only owners may run commands. Set MODE=public in .env to open the bot to everyone.');
  }

  const spamActions = SPAM_ACTION.split('+').map(part => part.trim());
  const unknownActions = spamActions.filter(
    action => !['delete', 'warn', 'kick', 'block', 'none'].includes(action)
  );
  if (unknownActions.length) {
    warnings.push(`SPAM_ACTION has unknown parts: ${unknownActions.join(', ')}. Known: delete, warn, kick, block.`);
  }

  if (STATUS_FILTER_MODE === 'whitelist' && !STATUS_WHITELIST.length) {
    warnings.push('STATUS_FILTER_MODE=whitelist but STATUS_WHITELIST is empty: no status would ever be processed.');
  }

  if (TIMEZONE.toLowerCase() === 'auto' && !process.env.TZ) {
    warnings.push('TIMEZONE=auto: the host zone is used when it is a real IANA name, otherwise Africa/Nairobi.');
  }

  return warnings;
}

module.exports = {
  ROOT,
  DATA_DIR,
  SESSION_DIR,
  ASSETS_DIR,
  DOWNLOADS_DIR,
  STATUS_DOWNLOAD_DIR,
  SETTINGS_FILE,
  OWNERS_FILE,
  GLOBAL_FILE,
  STATUS_DB_FILE,
  QR_FILE,
  MENU_IMAGE_PATH,
  MENU_IMAGE_URL,
  OWNER_NUMBER,
  PAIRING_NUMBER,
  PAIRING_CODE,
  PAIR_WELCOME,
  PREFIX,
  BOT_NAME,
  MENU_TITLE,
  MODE,
  TIMEZONE,
  SPAM_WINDOW_SECONDS,
  SPAM_MESSAGE_LIMIT,
  SPAM_ACTION,
  SPAM_WARN_LIMIT,
  DEBUG_LOG,
  PROTECTED_USERS,
  REACTION_POOL,
  AUTOSTATUS_DESTINATION,
  STATUS_IGNORE,
  STATUS_FILTER_MODE,
  STATUS_WHITELIST,
  STATUS_DEDUP_TTL_HOURS,
  STATUS_MAX_MEDIA_BYTES,
  MUSIC_RESULT_COUNT,
  MUSIC_MAX_SECONDS,
  MUSIC_MAX_BYTES,
  MUSIC_YTDLP_ENDPOINT,
  digits,
  validate
};
