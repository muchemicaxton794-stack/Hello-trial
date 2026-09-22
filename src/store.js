'use strict';

const fs = require('fs');
const path = require('path');

/**
 * JSON file stores with atomic writes and corruption quarantine.
 *
 * The original implementation used a bare writeFileSync on every toggle, so a
 * crash mid-write left a partial settings.json, and loadSettings() silently
 * returned {} - every group's settings disappeared with no error. Here a file
 * that fails to parse is quarantined (renamed, never deleted) so the damage is
 * visible and recoverable.
 */

function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[store] cannot read ${file}: ${error.message}`);
    return { data: structuredClone(fallback), recovered: false };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value is not an object');
    }
    return { data: parsed, recovered: false };
  } catch (error) {
    const kept = quarantine(file);
    console.error(`[store] ${file} was corrupt (${error.message}).`);
    if (kept) console.error(`[store] kept the damaged file as ${kept} and started from defaults.`);
    return { data: structuredClone(fallback), recovered: true };
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file); // atomic within the same filesystem
}

/**
 * Keyed store where `defaults` maps each key to its own default value.
 * Used for owners.json ({ owners: [] }) and global.json ({ anticall: false }).
 */
function createStore({ file, defaults = {} }) {
  const data = readJson(file, {}).data;

  const api = {
    file,

    get(key) {
      if (Object.prototype.hasOwnProperty.call(data, key)) return data[key];
      if (!Object.prototype.hasOwnProperty.call(defaults, key)) return undefined;
      data[key] = structuredClone(defaults[key]);
      api.save();
      return data[key];
    },

    set(key, value) {
      data[key] = value;
      return api.save();
    },

    has: key => Object.prototype.hasOwnProperty.call(data, key),
    keys: () => Object.keys(data),
    all: () => data,
    save: () => writeJson(file, data)
  };

  return api;
}

/**
 * Per-key object store where every key shares the same `defaults` shape.
 * Used for settings.json, whose keys are group JIDs. Missing fields are filled
 * in on read, which is how new toggles reach already-stored groups.
 */
function createObjectStore({ file, defaults = {} }) {
  const data = readJson(file, {}).data;

  const api = {
    file,

    get(key) {
      const existing = data[key];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        let changed = false;
        for (const [name, value] of Object.entries(defaults)) {
          if (!Object.prototype.hasOwnProperty.call(existing, name)) {
            existing[name] = value;
            changed = true;
          }
        }
        if (changed) api.save();
        return existing;
      }
      data[key] = structuredClone(defaults);
      api.save();
      return data[key];
    },

    set(key, patch) {
      Object.assign(api.get(key), patch);
      return api.save();
    },

    delete(key) {
      delete data[key];
      return api.save();
    },

    has: key => Object.prototype.hasOwnProperty.call(data, key),
    keys: () => Object.keys(data),
    all: () => data,
    save: () => writeJson(file, data)
  };

  return api;
}

module.exports = { createStore, createObjectStore, readJson, writeJson, quarantine };
