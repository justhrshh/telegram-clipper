import { parseTimestampToSeconds } from './validator.js';

export const MAX_BATCH_CLIPS = Number(process.env.MAX_BATCH_CLIPS) || 5;

/**
 * Parses a single timestamp token which may be:
 * - 'MM:SS' (e.g. '01:30').
 * - 'HH:MM:SS' (e.g. '01:15:30')
 * - raw integer/float seconds (e.g. '10', '75')
 *
 * @param {string} token
 * @returns {number|null} Seconds as number, or null if invalid
 */
export function parseFlexibleTimestamp$(token) {
  if (!token || typeof token !== 'string') return null;
  const t = token.trim();
  if (!t) return null;

  if (t.includes(':')) {
    return parseTimestampToSeconds(t);
  }

  const num = Number(t);
  if (!isNaN(num) && isFinite(num) && num >= 0) {
    return Math.floor(num);
  }

  return null;
}

export const parseFlexibleTimestamp = parseFlexibleTimestamp$;

/**
 * Formats seconds into canonical MM:SS or HI:MM:SS string.
 *
 * @param {number} sec
 * @returns {string}
 */
export function canonicalTimestamp(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Parses and validates multi-line clip range inputs.
 */
export function parseBatchRanges(rawText, maxClips = MAX_BATCH_CLIPS) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      valid: false,
      error: 'Please provide at least one clip range (e.g., 00:10-00:30).',
    };
  }

  const lines = rawText
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      valid: false,
      error: 'No clip ranges found. Please enter one range per line (e.g. 00:10-00:30).',
    };
  }

  if (lines.length > maxClips) {
    return {
      valid: false,
      error: `You entered ${lines.length} clip ranges. Maximum ${maxClips} clips allowed per batch. Please remove some ranges and try again.`,
    };
  }

  const parsedRanges = [];
  const seenRanges = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];

    let parts = null;
    if (/\s+to\s+/i.test(rawLine)) {
      parts = rawLine.split(/\s+to\s+/i);
    } else if (/[-–—\u2010-\u2015]/.test(rawLine)) {
      parts = rawLine.split(/[-–—\u2010-\u2015]/);
    } else {
      return {
        valid: false,
        error: `Line ${lineNum} ("${rawLine}") is missing a delimiter. Expected format: 00:10-00:30 (dash, hyphen, or 'to').`,
      };
    }

    if (parts.length !== 2) {
      return {
        valid: false,
        error: `Line ${lineNum} ("${rawLine}") has an invalid format. Expected format: 00:10-00:30.`,
      };
    }

    const rawStart = parts[0].trim();
    const rawEnd = parts[1].trim();

    const startSec = parseFlexibleTimestamp(parts[0]);
    if (startSec === null) {
      return {
        valid: false,
        error: `Line ${lineNum}: Invalid start timestamp "${rawStart}". Use MM:SS, HI:MM:SS, or seconds.`,
      };
    }

    const endSec = parseFlexibleTimestamp(parts[1]);
    if (endSec === null) {
      return {
        valid: false,
        error: `Line ${lineNum}: Invalid end timestamp "${rawEnd}". Use MM:SS, HH:MM:SS, or seconds.`,
      };
    }

    if (startSec < 0) {
      return {
        valid: false,
        error: `Line ${lineNum}: Start timestamp cannot be negative.`,
      };
    }

    if (endSec <= startSec) {
      return {
        valid: false,
        error: `Line ${lineNum} ("${rawLine}"): End timestamp (${canonicalTimestamp(endSec)}) must be greater than start timestamp (${canonicalTimestamp(startSec)}).`,
      };
    }

    const duration = endSec - startSec;
    if (duration < 1) {
      return {
        valid: false,
        error: `Line ${lineNum}: Clip duration must be at least 1 second.`,
      };
    }

    const rangeKey = `${startSec}-${endSec}`;
    if (seenRanges.has(rangeKey)) {
      return {
        valid: false,
        error: `Line ${lineNum} ("${rawLine}") is a duplicate of an earlier range in your batch.`,
      };
    }
    seenRanges.add(rangeKey);

    const startCanon = canonicalTimestamp(startSec);
    const endCanon = canonicalTimestamp(endSec);

    parsedRanges.push({
      index: lineNum,
      start: startCanon,
      end: endCanon,
      startSec,
      endSec,
      duration,
      formatted: `${startCanon} → ${endCanon} (${duration}s)`,
    });
  }

  return {
    valid: true,
    ranges: parsedRanges,
  };
}
