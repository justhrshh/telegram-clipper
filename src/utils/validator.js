/**
 * Input validators for YouTube URLs and video timestamps
 */

const YOUTUBE_REGEX =
  /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,32})(?:[?&][^\s]*)?$/;

// Matches MM:SS or HH:MM:SS format
// Examples: "01:30", "1:30", "01:15:30", "1:15:30"
const TIMESTAMP_REGEX = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

/**
 * Extracts canonical YouTube video ID from various URL formats, ignoring timestamps and extra query parameters.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname.includes('youtube.com')) {
      const v = parsed.searchParams.get('v');
      if (v) return v;

      const parts = parsed.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'live') && parts[1]) {
        return parts[1];
      }
    } else if (hostname.includes('youtu.be')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0]) return parts[0];
    }
  } catch {}

  const match = trimmed.match(YOUTUBE_REGEX);
  return match ? match[4] : null;
}

/**
 * Normalizes any YouTube URL variant to the canonical format:
 * https://www.youtube.com/watch?v=<videoId>
 * Removes timestamps, tracking tags, and resolves short links.
 *
 * @param {string} url
 * @returns {string}
 */
export function canonicalizeYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const videoId = extractYouTubeVideoId(url);
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url.trim();
}

/**
 * Validates whether a given string is a valid YouTube video URL.
 * @param {string} url 
 * @returns {boolean}
 */
export function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return YOUTUBE_REGEX.test(url.trim());
}

/**
 * Parses a timestamp (MM:SS, HH:MM:SS, pure seconds string, or number) into total seconds.
 * Returns null if the format is invalid or negative.
 * 
 * Supports:
 * - "13:10" -> 790
 * - "01:24" -> 84
 * - "1:05:32" -> 3932
 * - "0:45" -> 45
 * - "45" -> 45
 * - 45 -> 45
 *
 * @param {string|number} timestamp 
 * @returns {number|null} Total integer seconds or null if invalid
 */
export function parseTimestampToSeconds(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;

  // If already a finite non-negative number
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : null;
  }

  if (typeof timestamp !== 'string') return null;

  const trimmed = timestamp.trim();
  if (!trimmed) return null;

  // Pure digits / integer / decimal seconds e.g. "45", "790"
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
  }

  // Check colon-separated formats: MM:SS, M:SS, HH:MM:SS, H:MM:SS
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const [minStr, secStr] = parts;
    if (!/^\d+$/.test(minStr) || !/^\d+(?:\.\d+)?$/.test(secStr)) return null;
    const minutes = parseInt(minStr, 10);
    const seconds = parseFloat(secStr);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || seconds < 0 || seconds >= 60) {
      return null;
    }
    return Math.floor(minutes * 60 + seconds);
  }

  if (parts.length === 3) {
    const [hrStr, minStr, secStr] = parts;
    if (!/^\d+$/.test(hrStr) || !/^\d+$/.test(minStr) || !/^\d+(?:\.\d+)?$/.test(secStr)) return null;
    const hours = parseInt(hrStr, 10);
    const minutes = parseInt(minStr, 10);
    const seconds = parseFloat(secStr);
    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds) ||
      hours < 0 ||
      minutes < 0 ||
      minutes >= 60 ||
      seconds < 0 ||
      seconds >= 60
    ) {
      return null;
    }
    return Math.floor(hours * 3600 + minutes * 60 + seconds);
  }

  return null;
}

/**
 * Validates timestamp format (MM:SS or HH:MM:SS or seconds).
 * @param {string|number} timestamp 
 * @returns {boolean}
 */
export function isValidTimestamp(timestamp) {
  return parseTimestampToSeconds(timestamp) !== null;
}

/**
 * Validates start and end timestamps.
 * Checks that both formats are valid and that end timestamp > start timestamp.
 * @param {string|number} startTimestamp 
 * @param {string|number} endTimestamp 
 * @returns {{ valid: boolean, error?: string, startSeconds?: number, endSeconds?: number, duration?: number }}
 */
export function validateTimestampRange(startTimestamp, endTimestamp) {
  const startSeconds = parseTimestampToSeconds(startTimestamp);
  if (startSeconds === null) {
    return {
      valid: false,
      error: 'Invalid start timestamp format. Please use MM:SS (e.g. 01:30) or HH:MM:SS (e.g. 01:15:00).',
    };
  }

  const endSeconds = parseTimestampToSeconds(endTimestamp);
  if (endSeconds === null) {
    return {
      valid: false,
      error: 'Invalid end timestamp format. Please use MM:SS (e.g. 02:30) or HH:MM:SS (e.g. 01:16:00).',
    };
  }

  if (endSeconds <= startSeconds) {
    return {
      valid: false,
      error: `End timestamp (${endTimestamp}) must be greater than start timestamp (${startTimestamp}).`,
      startSeconds,
      endSeconds,
      duration: 0,
    };
  }

  return {
    valid: true,
    startSeconds,
    endSeconds,
    duration: endSeconds - startSeconds,
  };
}
