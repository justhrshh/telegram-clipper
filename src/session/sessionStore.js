/**
 * In-memory Session Store for per-user Telegram conversation state.
 *
 * Supported states:
 * - 'awaiting_url': waiting for user to send a YouTube link
 * - 'awaiting_start': waiting for start timestamp (MM:SS or HH:MM:SS)
 * - 'awaiting_end': waiting for end timestamp (MM:SS or HH:MM:SS)
 * - 'awaiting_captions': waiting for captions choice (YES / NO via inline keyboard)
 */

export const SessionState = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_URL: 'awaiting_url',
  AWAITING_START: 'awaiting_start',
  AWAITING_END: 'awaiting_end',
  AWAITING_RATIO: 'awaiting_ratio',
  AWAITING_PRESENTATION: 'awaiting_presentation',
  AWAITING_CAPTIONS: 'awaiting_captions',
  AWAITING_STYLE: 'awaiting_style',
  CAPTION_STUDIO: 'caption_studio',
  AWAITING_PRESET_NAME: 'awaiting_preset_name',
  AWAITING_BATCH_RANGES: 'awaiting_batch_ranges',
  AWAITING_BATCH_CONFIRMATION: 'awaiting_batch_confirmation',
});

import { logger } from '../utils/logger.js';

export const SESSION_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// Deterministic virtual clock control for automated testing
let clockOffsetMs = 0;

/**
 * Returns current timestamp factoring in test virtual clock offset.
 * @returns {number}
 */
export function getNow() {
  return Date.now() + clockOffsetMs;
}

/**
 * Advances the virtual clock by the specified milliseconds (for testing).
 * @param {number} ms
 * @returns {number} New virtual timestamp
 */
export function advanceClock(ms) {
  clockOffsetMs += Number(ms) || 0;
  return getNow();
}

/**
 * Explicitly sets virtual clock offset in milliseconds (for testing).
 * @param {number} ms
 * @returns {number}
 */
export function setClockOffset(ms) {
  clockOffsetMs = Number(ms) || 0;
  return getNow();
}

/**
 * Resets virtual clock offset to zero (real time).
 */
export function resetClock() {
  clockOffsetMs = 0;
}

// Map of userId (string or number) -> session object
const store = new Map();

// Map of userId -> boolean indicating session expired due to inactivity
const expiredNoticePending = new Map();

// Map of userId -> latest successfully used/completed YouTube URL
const userLastUrl = new Map();
const userLastSettings = new Map();

// Periodic cleanup interval handle
let cleanupIntervalId = null;

/**
 * Checks if a session has expired based on inactivity duration.
 * @param {object} session
 * @returns {boolean}
 */
export function isSessionExpired(session) {
  if (!session) return true;
  const lastActive = session.lastInteractionAt || session.updatedAt || session.createdAt || 0;
  return (getNow() - lastActive) >= SESSION_INACTIVITY_TIMEOUT_MS;
}

/**
 * Persists the most recent YouTube URL for a user session.
 * @param {string|number} userId
 * @param {string} url
 */
export function setUserLastUrl(userId, url) {
  if (!userId || !url) return;
  userLastUrl.set(String(userId), String(url).trim());
}

/**
 * Retrieves the most recent YouTube URL for a user session.
 * @param {string|number} userId
 * @returns {string|null}
 */
export function getUserLastUrl(userId) {
  if (!userId) return null;
  return userLastUrl.get(String(userId)) || null;
}

/**
 * Persists the most recent job settings for a user session.
 * @param {string|number} userId
 * @param {object} settings
 */
export function setUserLastSettings(userId, settings) {
  if (!userId || !settings) return;
  userLastSettings.set(String(userId), settings);
  if (settings.url) {
    setUserLastUrl(userId, settings.url);
  }
}

/**
 * Retrieves the most recent job settings for a user session.
 * @param {string|number} userId
 * @returns {object|null}
 */
export function getUserLastSettings(userId) {
  if (!userId) return null;
  return userLastSettings.get(String(userId)) || null;
}

/**
 * Creates or resets a session for the specified user.
 * @param {string|number} userId 
 * @param {string} initialState Default is SessionState.AWAITING_URL
 * @returns {object} The initialized session
 */
export function createSession(userId, initialState = SessionState.AWAITING_URL, initialData = {}) {
  const uid = String(userId);
  // Clear any pending expiration notification when user begins a fresh session
  expiredNoticePending.delete(uid);

  const now = getNow();
  const session = {
    userId: uid,
    state: initialState,
    data: {
      url: null,
      startTime: null,
      endTime: null,
      ratio: 'vertical',
      presentation: 'standard',
      captions: null,
      captionStyle: null,
      ...initialData,
    },
    createdAt: now,
    updatedAt: now,
    lastInteractionAt: now,
  };

  store.set(uid, session);
  return session;
}

/**
 * Resets a session for the user (alias of createSession).
 * @param {string|number} userId 
 * @param {string} state 
 * @returns {object}
 */
export function resetSession(userId, state = SessionState.IDLE) {
  return createSession(userId, state);
}

/**
 * Retrieves the current session for a user, performing lazy expiration check.
 * If expired, the session is purged, a notice is queued, and null is returned.
 * @param {string|number} userId 
 * @returns {object|null}
 */
export function getSession(userId) {
  if (!userId) return null;
  const uid = String(userId);
  const session = store.get(uid);
  if (!session) return null;

  if (isSessionExpired(session)) {
    const elapsed = getNow() - (session.lastInteractionAt || session.updatedAt || session.createdAt);
    store.delete(uid);
    expiredNoticePending.set(uid, true);
    logger.info(`[SESSION] user=${uid} expired_after_ms=${elapsed} (timeout: ${SESSION_INACTIVITY_TIMEOUT_MS}ms)`);
    return null;
  }

  return session;
}

/**
 * Refreshes the lastInteractionAt timestamp for an active user session.
 * @param {string|number} userId
 * @returns {boolean} True if active session was refreshed, false if none or expired
 */
export function refreshSessionInteraction(userId) {
  if (!userId) return false;
  const uid = String(userId);
  const session = store.get(uid);
  if (!session) return false;

  if (isSessionExpired(session)) {
    store.delete(uid);
    expiredNoticePending.set(uid, true);
    return false;
  }

  session.lastInteractionAt = getNow();
  session.updatedAt = getNow();
  return true;
}

/**
 * Checks whether user has an active, non-expired session.
 * @param {string|number} userId
 * @returns {boolean}
 */
export function hasActiveSession(userId) {
  return getSession(userId) !== null;
}

/**
 * Checks if user has a pending expired session notice and consumes it (clears flag).
 * @param {string|number} userId
 * @returns {boolean}
 */
export function checkAndConsumeExpiredNotice(userId) {
  if (!userId) return false;
  const uid = String(userId);
  if (expiredNoticePending.get(uid)) {
    expiredNoticePending.delete(uid);
    return true;
  }
  return false;
}

/**
 * Explicitly clears any pending expired notice for a user.
 * @param {string|number} userId
 */
export function clearExpiredNotice(userId) {
  if (!userId) return;
  expiredNoticePending.delete(String(userId));
}

/**
 * Updates an existing session with partial state and/or data fields.
 * If the session does not exist or expired, a new one is created first.
 * @param {string|number} userId 
 * @param {object} updates 
 * @param {string} [updates.state]
 * @param {object} [updates.data]
 * @returns {object} Updated session
 */
export function updateSession(userId, updates = {}) {
  let session = getSession(userId);
  if (!session) {
    session = createSession(userId);
  }

  if (updates.state !== undefined) {
    session.state = updates.state;
  }

  if (updates.data && typeof updates.data === 'object') {
    session.data = {
      ...session.data,
      ...updates.data,
    };
  }

  const now = getNow();
  session.updatedAt = now;
  session.lastInteractionAt = now;
  store.set(String(userId), session);
  return session;
}

/**
 * Deletes a user's session.
 * @param {string|number} userId 
 * @returns {boolean} True if deleted, false if did not exist
 */
export function deleteSession(userId) {
  return store.delete(String(userId));
}

/**
 * Sweeps the in-memory store and deletes all expired sessions.
 * @returns {number} Number of sessions swept
 */
export function sweepExpiredSessions() {
  let count = 0;
  for (const [uid, session] of store.entries()) {
    if (isSessionExpired(session)) {
      store.delete(uid);
      expiredNoticePending.set(uid, true);
      count++;
      logger.info(`[SESSION_SWEEP] user=${uid} pruned due to inactivity`);
    }
  }
  return count;
}

/**
 * Starts periodic session cleanup interval.
 * @param {number} intervalMs Default 5 minutes
 */
export function startSessionCleanup(intervalMs = 5 * 60 * 1000) {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(() => {
    try {
      const purged = sweepExpiredSessions();
      if (purged > 0) {
        logger.debug(`[SESSION_CLEANUP] Purged ${purged} expired session(s)`);
      }
    } catch (err) {
      logger.error('[SESSION_CLEANUP] Error during sweep:', err);
    }
  }, intervalMs);

  if (cleanupIntervalId.unref) {
    cleanupIntervalId.unref();
  }
}

/**
 * Stops periodic session cleanup interval.
 */
export function stopSessionCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

/**
 * Clears all sessions and stores (for tests).
 */
export function clearAllSessions() {
  store.clear();
  expiredNoticePending.clear();
  userLastUrl.clear();
  userLastSettings.clear();
  resetClock();
}

/**
 * Returns the total number of active sessions (useful for debugging/monitoring).
 * @returns {number}
 */
export function getSessionCount() {
  return store.size;
}

