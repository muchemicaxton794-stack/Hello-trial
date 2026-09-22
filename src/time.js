'use strict';

/**
 * The single source of every timestamp in the bot.
 *
 * Nothing else may call Date directly for display, compute an offset by hand, or
 * assume UTC. Every status event, spam log, punishment log, command log, welcome
 * and goodbye message, debug line and scheduler tick goes through here, so they
 * cannot disagree with each other.
 *
 * Resolution:
 *   TIMEZONE=auto            -> the host zone, when it is a real IANA name
 *   TIMEZONE=Africa/Nairobi  -> that zone, validated
 *   anything invalid         -> Africa/Nairobi, with a warning
 */

const FALLBACK_ZONE = 'Africa/Nairobi';

let resolved = null;

/** A zone is usable only if Intl accepts it as an IANA name. */
function isValidZone(name) {
  if (!name || typeof name !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The zone Node itself is running in, which `TZ` controls. */
function hostZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * Resolves the configured value exactly once and caches it, so every caller for
 * the lifetime of the process shares one answer.
 */
function resolve(configured = 'auto') {
  if (resolved) return resolved;

  const value = String(configured || 'auto').trim();

  if (value && value.toLowerCase() !== 'auto') {
    resolved = isValidZone(value)
      ? { zone: value, source: 'configured', warning: null }
      : {
          zone: FALLBACK_ZONE,
          source: 'fallback',
          warning: `TIMEZONE "${value}" is not a valid IANA zone; using ${FALLBACK_ZONE}.`
        };
    return resolved;
  }

  const detected = hostZone();
  // A bare "UTC" from a container is not a usable answer for a chat bot, so it
  // falls through to the documented default instead of silently using UTC.
  if (detected && detected !== 'UTC' && isValidZone(detected)) {
    resolved = { zone: detected, source: 'auto', warning: null };
    return resolved;
  }

  resolved = {
    zone: FALLBACK_ZONE,
    source: 'auto-fallback',
    warning: `Host time zone is "${detected || 'unknown'}"; using ${FALLBACK_ZONE}. Set TIMEZONE to choose.`
  };
  return resolved;
}

/** Test hook: forget the cached resolution. */
function reset() {
  resolved = null;
}

function getConfiguredTimezone(configValue) {
  return resolve(configValue).zone;
}

const PARTS_FORMATTERS = new Map();

function partsFormatter(zone) {
  if (!PARTS_FORMATTERS.has(zone)) {
    PARTS_FORMATTERS.set(
      zone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short'
      })
    );
  }
  return PARTS_FORMATTERS.get(zone);
}

/** Calendar fields as seen in the configured zone. */
function zonedParts(date = new Date(), zone = getConfiguredTimezone()) {
  const parts = {};
  for (const { type, value } of partsFormatter(zone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = value;
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // "24" appears for midnight in some ICU builds; normalise it.
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    second: parts.second,
    weekday: parts.weekday
  };
}

/** "2026-09-21" */
function getCurrentDate(date = new Date(), zone) {
  const p = zonedParts(date, zone ? getConfiguredTimezone(zone) : undefined);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "21:20:45" */
function getCurrentTime(date = new Date(), zone) {
  const p = zonedParts(date, zone ? getConfiguredTimezone(zone) : undefined);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** "2026-09-21 21:20:45 Africa/Nairobi" - the shape used for every log line. */
function formatTimestamp(date = new Date(), zone = getConfiguredTimezone()) {
  const p = zonedParts(date, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${zone}`;
}

/** "[2026-09-21 21:20:45 Africa/Nairobi]" prefix for debug logging. */
function logPrefix(date = new Date()) {
  return `[${formatTimestamp(date)}]`;
}

/**
 * Minutes since midnight in the configured zone. Scheduling compares these
 * rather than parsing dates, so a scheduled time means the same thing every day
 * regardless of the server clock.
 */
function minutesOfDay(date = new Date()) {
  const p = zonedParts(date);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "08:00,13:00,18:00" -> [480, 780, 1080]; invalid entries are dropped. */
function parseSchedule(value) {
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .map(entry => {
      const match = entry.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return hour * 60 + minute;
    })
    .filter(entry => entry !== null)
    .sort((a, b) => a - b);
}

function minutesToLabel(minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

/** Human readable gap, used by .runtime and uptime replies. */
function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

module.exports = {
  FALLBACK_ZONE,
  isValidZone,
  hostZone,
  resolve,
  reset,
  getConfiguredTimezone,
  zonedParts,
  getCurrentDate,
  getCurrentTime,
  formatTimestamp,
  logPrefix,
  minutesOfDay,
  parseSchedule,
  minutesToLabel,
  formatDuration
};
