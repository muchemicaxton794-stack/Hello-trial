'use strict';

/**
 * The single gate every automatic punishment must pass.
 *
 * AntiSpam, AntiMessage, AntiLink, AntiSticker, AutoBlock, AutoKick and
 * AutoDemote all call isProtectedUser() before acting. It returns a reason as
 * well as a verdict so the debug log can say *why* someone was spared instead of
 * leaving a silent gap.
 *
 * Protected: the owner number, every sudo entry, the bot's own account, any
 * configured whitelist entry, and the group owner/creator. The creator is read
 * from group metadata rather than inferred, because "who owns this group" is not
 * otherwise knowable.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

function numberOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function normalize(jid) {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return String(jid);
  }
}

/** Same human, allowing for a device suffix or a LID/PN difference. */
function sameUser(a, b) {
  if (!a || !b) return false;
  return normalize(a) === normalize(b) || (numberOf(a) && numberOf(a) === numberOf(b));
}

function createProtection({ socket, ownerNumbers = [], extraNumbers = [], sudoStore, log = () => {} }) {
  // Kept as two sets so the reported reason is exact rather than a guess.
  const owners = new Set(ownerNumbers.map(numberOf).filter(Boolean));
  const whitelist = new Set(extraNumbers.map(numberOf).filter(Boolean));

  let metadataCache = { jid: null, at: 0, meta: null };
  const META_TTL_MS = 30000;

  async function groupMeta(jid) {
    const now = Date.now();
    if (metadataCache.jid === jid && now - metadataCache.at < META_TTL_MS) return metadataCache.meta;
    const meta = await socket.groupMetadata(jid);
    metadataCache = { jid, at: now, meta };
    return meta;
  }

  function sudoNumbers() {
    const list = sudoStore ? sudoStore.get('owners') || [] : [];
    return new Set((Array.isArray(list) ? list : []).map(numberOf).filter(Boolean));
  }

  function botIdentities() {
    return [socket.user?.id, socket.user?.lid].filter(Boolean);
  }

  /**
   * @returns {Promise<{protected: boolean, reason: string|null}>}
   */
  async function check(jid, { chatJid, meta } = {}) {
    if (!jid) return { protected: false, reason: null };

    if (sameUser(jid, socket.user?.id) || botIdentities().some(identity => sameUser(jid, identity))) {
      return { protected: true, reason: 'bot account' };
    }

    const number = numberOf(jid);
    if (owners.has(number)) return { protected: true, reason: 'owner number' };
    if (whitelist.has(number)) return { protected: true, reason: 'whitelist' };
    if (sudoNumbers().has(number)) return { protected: true, reason: 'owner (sudo)' };

    if (chatJid && String(chatJid).endsWith('@g.us')) {
      try {
        const data = meta || (await groupMeta(chatJid));
        const owner = data?.owner || data?.subjectOwner;
        if (owner && sameUser(owner, jid)) return { protected: true, reason: 'group owner' };

        const participant = (data?.participants || []).find(
          entry => sameUser(entry.id, jid) || (entry.lid && sameUser(entry.lid, jid))
        );
        if (participant?.admin === 'superadmin') return { protected: true, reason: 'group owner' };
      } catch (error) {
        // Metadata unavailable (bot removed, network): fail closed for the
        // *protection* check only when we can be sure, otherwise let the caller
        // decide. Not knowing is reported, never guessed at.
        log(`[protected] could not read metadata for ${chatJid}: ${error?.message || error}`);
      }
    }

    return { protected: false, reason: null };
  }

  /** Convenience boolean for call sites that do not log the reason. */
  async function isProtectedUser(jid, options) {
    return (await check(jid, options)).protected;
  }

  /** The configured numbers, for .protect / diagnostics output. */
  function listProtected() {
    return {
      owners: [...owners],
      whitelist: [...whitelist],
      sudo: [...sudoNumbers()],
      bot: botIdentities()
    };
  }

  return { check, isProtectedUser, listProtected, sameUser, numberOf, normalize, groupMeta };
}

module.exports = { createProtection, sameUser, numberOf, normalize };
