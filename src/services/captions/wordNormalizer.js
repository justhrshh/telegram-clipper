/**
 * Word Normalizer
 *
 * Enriches raw speech-to-text word objects with linguistic tokens,
 * punctuation markers, sentence boundaries, pause durations,
 * and clean uppercase tokens for reliable downstream scoring.
 */

const SENTENCE_END_REGEX = /[.?!]+$/;
const CLAUSE_END_REGEX = /[,;:]+$/;
const CLEAN_TOKEN_REGEX = /[^A-Z0-9$%]/g;

/**
 * Normalizes an array of raw Whisper word objects into enriched, structured tokens.
 *
 * @param {Array<{ word: string, start: number, end: number, probability?: number }>} rawWords
 * @returns {Array<{
 *   text: string,
 *   cleanWord: string,
 *   start: number,
 *   end: number,
 *   duration: number,
 *   punctuation: string,
 *   isSentenceEnd: boolean,
 *   isClauseEnd: boolean,
 *   pauseAfter: number,
 *   index: number,
 *   raw: object
 * }>}
 */
export function normalizeWords(rawWords = []) {
  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    return [];
  }

  const normalized = [];

  for (let i = 0; i < rawWords.length; i++) {
    const raw = rawWords[i];
    const text = String(raw.word || '').trim();
    if (!text) continue;

    const start = Math.max(0, Number(raw.start) || 0);
    const end = Math.max(start + 0.01, Number(raw.end) || start + 0.1);
    const duration = Math.max(0.01, Math.round((end - start) * 1000) / 1000);

    // Extract punctuation
    const sentenceEndMatch = text.match(SENTENCE_END_REGEX);
    const clauseEndMatch = text.match(CLAUSE_END_REGEX);
    const isSentenceEnd = Boolean(sentenceEndMatch);
    const isClauseEnd = Boolean(clauseEndMatch) && !isSentenceEnd;
    const punctuation = isSentenceEnd
      ? sentenceEndMatch[0]
      : (isClauseEnd ? clauseEndMatch[0] : '');

    // Uppercase alphanumeric clean token (retains '$' and '%' for financial/numeric scoring)
    const cleanWord = text.toUpperCase().replace(CLEAN_TOKEN_REGEX, '');

    normalized.push({
      text,
      cleanWord,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration,
      punctuation,
      isSentenceEnd,
      isClauseEnd,
      pauseAfter: 0,
      index: normalized.length,
      raw,
    });
  }

  // Calculate pauses between adjacent words
  for (let i = 0; i < normalized.length - 1; i++) {
    const cur = normalized[i];
    const next = normalized[i + 1];
    const pause = Math.max(0, Math.round((next.start - cur.end) * 1000) / 1000);
    cur.pauseAfter = pause;
  }

  return normalized;
}
