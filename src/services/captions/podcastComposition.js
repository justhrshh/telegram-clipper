/**
 * Podcast Caption Composition Engine V4
 *
 * Implements word-by-word kinetic beat structuring for modern podcast Shorts:
 * - Default: ONE WORD AT A TIME
 * - Natural 2-word combinations for tightly coupled phrases or rapid speech
 *   (e.g., "DO IT", "VERY SOON", "BEING REPLACED", "GOING TO")
 * - Occasional 3-word combinations only when rhythmically cohesive and speech rate supports it
 * - Standalone climax / punch breakout for high-impact words (e.g., "AI", "HUGE", "HAPPEN", "REPLACED")
 * - Two-line stack balancing (e.g. "DO\nIT", "BEING\nREPLACED")
 * - Word replacement (instant transition on spoken word timestamps, no paragraph stacking)
 * - Fixed chest-level region alignment
 */

import { IntensityLevel } from './captionEmphasis.js';

export const CompositionType = Object.freeze({
  SINGLE_WORD: 'single-word',
  TWO_WORD: 'two-word',
  THREE_WORD: 'three-word',
});

// Common tight two-word collocations that are visually stronger as a single beat
const TIGHT_TWO_WORD_PHRASES = new Set([
  'DO IT', 'VERY SOON', 'GOING TO', 'BEING REPLACED', 'THIS IS', 'RIGHT NOW',
  'SO MUCH', 'NOT YET', 'A LOT', 'OUT OF', 'TO BE', 'WILL BE', 'CAN BE',
  'HAVE TO', 'WANT TO', 'NEED TO', 'TRY TO', 'IN THE', 'ON THE', 'OF THE',
  'AT THE', 'FOR THE', 'WITH THE', 'BY THE', 'TOO MUCH', 'EVEN MORE',
  'NOT ONLY', 'ALL OF', 'SOME OF', 'KIND OF', 'SORT OF', 'LOOK AT',
  'COME ON', 'LET GO', 'SET UP', 'PICK UP', 'GIVE UP', 'CHECK OUT',
]);

// Short adverb/intensifier modifiers that pair with following word (e.g. VERY SOON, SO MUCH, RIGHT NOW)
const MODIFIER_BINDERS = new Set([
  'VERY', 'SO', 'TOO', 'MORE', 'MOST', 'RIGHT', 'QUITE', 'ALMOST', 'EVEN',
]);

// Auxiliary & function words that naturally initiate a 2-word phrase
const AUX_PHRASE_STARTERS = new Set([
  'GOING', 'BEING', 'TRYING', 'LOOKING', 'WANTING',
]);

// Climax vocabulary that triggers single-word punch breakout
const STANDALONE_CLIMAX_LEXICON = new Set([
  'REPLACED', 'REPLACE', 'HUGE', 'AI', 'EVERYTHING', 'IMPORTANT', 'IMPOSSIBLE',
  'DESTROYED', 'DESTROY', 'EXPLODE', 'CRASH', 'FATAL', 'WARNING', '10X', 'STOP',
  'INSANE', 'CRAZY', 'MASSIVE', 'ACTION', 'SECRET', 'WEALTH', 'HAPPEN',
  'EMPOWERING', 'GRADUATES', 'MANAGE', 'REVOLUTION', 'UNSTOPPABLE', 'SHOCKING',
  'DEAD', 'KILL', 'LIES', 'TRUTH', 'WIN', 'LOSE', 'FAILURE', 'SUCCESS',
]);

/**
 * Calculates the local speech rate (words per second) around a given token index.
 *
 * @param {Array<object>} tokens
 * @param {number} index
 * @param {number} [windowSize=3]
 * @returns {number} Words per second
 */
export function calculateLocalSpeechRate(tokens = [], index = 0, windowSize = 3) {
  if (!tokens || tokens.length === 0) return 2.5;
  const startIdx = Math.max(0, index - 1);
  const endIdx = Math.min(tokens.length - 1, index + windowSize);
  const count = endIdx - startIdx + 1;
  const timeSpan = Math.max(0.1, tokens[endIdx].end - tokens[startIdx].start);
  return Math.round((count / timeSpan) * 10) / 10;
}

/**
 * Determines whether a word qualifies for single-word punch breakout.
 *
 * @param {object} word
 * @param {number} [threshold=0.88]
 * @returns {boolean}
 */
export function shouldTriggerSingleWordPunch(word, threshold = 0.88) {
  if (!word) return false;
  const clean = word.cleanWord;

  if (STANDALONE_CLIMAX_LEXICON.has(clean)) return true;
  if (word.punctuation && word.punctuation.includes('!') && clean.length >= 3) return true;
  if (word.emphasisScore >= 0.94 && STANDALONE_CLIMAX_LEXICON.has(clean)) return true;

  return false;
}

/**
 * Splits a group of words into balanced stacked lines.
 *
 * Supports two-line compositions like:
 * DO
 * IT
 * or:
 * BEING
 * REPLACED
 *
 * @param {Array<object>} words
 * @param {number} [maxCharsPerLine=16]
 * @returns {Array<{ words: Array<object> }>} Array of line objects
 */
export function balanceLines(words = [], maxCharsPerLine = 16) {
  if (!words || words.length === 0) return [{ words: [] }];

  if (words.length === 1) {
    return [{ words }];
  }

  // Two-word phrase evaluation
  if (words.length === 2) {
    const w1 = words[0];
    const w2 = words[1];
    const phrase = `${w1.cleanWord} ${w2.cleanWord}`;
    const totalChars = words.map((w) => w.text).join(' ').length;
    const hasPunch = w1.isPunch || w2.isPunch;
    const hasEmphasis = w1.isEmphasis || w2.isEmphasis || hasPunch;

    // Explicit stacked 2-line triggers:
    // 1. "BEING REPLACED" or "DO IT" when stacked composition is visually punchier
    // 2. Total chars >= 11 (e.g. "BEING REPLACED", "RIGHT NOW", "VERY SOON")
    // 3. Either word is punch/emphasized and w1 is relatively short (≤ 5 chars)
    if (
      phrase === 'BEING REPLACED' ||
      phrase === 'DO IT' ||
      totalChars >= 11 ||
      (hasEmphasis && w1.cleanWord.length <= 5)
    ) {
      return [{ words: [w1] }, { words: [w2] }];
    }
    return [{ words }];
  }

  // Three-word phrase evaluation
  if (words.length === 3) {
    const totalChars = words.map((w) => w.text).join(' ').length;
    if (totalChars <= 9 && !words.some((w) => w.isPunch)) {
      return [{ words }];
    }

    const split1_line1 = words[0].text;
    const split1_line2 = `${words[1].text} ${words[2].text}`;
    const diff1 = Math.abs(split1_line1.length - split1_line2.length);

    const split2_line1 = `${words[0].text} ${words[1].text}`;
    const split2_line2 = words[2].text;
    const diff2 = Math.abs(split2_line1.length - split2_line2.length);

    const word2IsPunch = words[2].isPunch || words[2].isEmphasis;
    const score2 = diff2 - (word2IsPunch ? 3 : 0);

    if (score2 <= diff1) {
      return [{ words: [words[0], words[1]] }, { words: [words[2]] }];
    } else {
      return [{ words: [words[0]] }, { words: [words[1], words[2]] }];
    }
  }

  // Fallback for 4+ words (e.g. karaoke)
  return [
    { words: words.slice(0, 2) },
    { words: words.slice(2) },
  ];
}

/**
 * Checks whether two adjacent words naturally form a 2-word phrase.
 *
 * @param {object} w1 - First token
 * @param {object} w2 - Second token
 * @param {number} [localSpeechRate=2.5] - Words per second
 * @returns {boolean}
 */
export function shouldPairWords(w1, w2, localSpeechRate = 2.5) {
  if (!w1 || !w2) return false;

  // Never pair across sentence or clause boundaries
  if (w1.isSentenceEnd || w1.isClauseEnd || w1.pauseAfter >= 0.16) {
    return false;
  }

  const c1 = w1.cleanWord;
  const c2 = w2.cleanWord;
  const phrase = `${c1} ${c2}`;

  // 1. Explicit designated tight two-word phrases ALWAYS pair
  if (TIGHT_TWO_WORD_PHRASES.has(phrase)) {
    return true;
  }

  // Never pair if either word is a standalone climax punch
  if (shouldTriggerSingleWordPunch(w1) || shouldTriggerSingleWordPunch(w2)) {
    return false;
  }

  // 2. Modifiers + following word (e.g. "VERY SOON", "SO MUCH", "RIGHT NOW", "NOT YET")
  if (MODIFIER_BINDERS.has(c1) && w1.pauseAfter <= 0.12) {
    return true;
  }

  // 3. Auxiliary starters (e.g. "GOING TO", "BEING ...")
  if (AUX_PHRASE_STARTERS.has(c1) && w1.pauseAfter <= 0.12) {
    return true;
  }

  // 4. Fast contiguous speech: both words are short (dur <= 0.18s each) and close together
  const dur1 = w1.end - w1.start;
  const dur2 = w2.end - w2.start;
  const gap = w2.start - w1.end;
  if (localSpeechRate >= 3.2 && dur1 <= 0.18 && dur2 <= 0.18 && gap <= 0.06) {
    return true;
  }

  return false;
}

/**
 * Checks whether three adjacent words form an acceptable 3-word phrase.
 * Only applied rarely in fast speech for tightly coupled short function words.
 *
 * @param {object} w1
 * @param {object} w2
 * @param {object} w3
 * @param {number} [localSpeechRate=2.5]
 * @returns {boolean}
 */
export function shouldTripleWords(w1, w2, w3, localSpeechRate = 2.5) {
  if (!w1 || !w2 || !w3) return false;

  // Never across punctuation boundaries
  if (w1.isSentenceEnd || w1.isClauseEnd || w2.isSentenceEnd || w2.isClauseEnd) {
    return false;
  }
  if (w1.pauseAfter >= 0.12 || w2.pauseAfter >= 0.12) {
    return false;
  }

  // Never if any word is punch
  if (
    shouldTriggerSingleWordPunch(w1) ||
    shouldTriggerSingleWordPunch(w2) ||
    shouldTriggerSingleWordPunch(w3)
  ) {
    return false;
  }

  const phrase3 = `${w1.cleanWord} ${w2.cleanWord} ${w3.cleanWord}`;
  const ACCEPTABLE_TRIPLES = new Set([
    'GOING TO BE', 'IT COULD BE', 'OUT OF THE', 'ONE OF THE', 'A LOT OF',
  ]);

  if (ACCEPTABLE_TRIPLES.has(phrase3)) {
    return true;
  }

  // Fast speech triple check: all 3 words are tiny (< 0.15s each), speech rate is very fast (> 3.5 wps)
  const dur1 = w1.end - w1.start;
  const dur2 = w2.end - w2.start;
  const dur3 = w3.end - w3.start;
  const totalChars = w1.text.length + w2.text.length + w3.text.length;

  if (
    localSpeechRate >= 3.8 &&
    dur1 <= 0.15 &&
    dur2 <= 0.15 &&
    dur3 <= 0.15 &&
    totalChars <= 11
  ) {
    return true;
  }

  return false;
}

/**
 * Composes normalized and emphasis-analyzed tokens into word-by-word editorial podcast beats.
 *
 * @param {Array<object>} tokens - Tokens from analyzeEmphasis()
 * @param {object} [options]
 * @param {object} [options.style] - Style preset
 * @returns {Array<object>} Visual caption beats
 */
export function composePodcastBeats(tokens = [], options = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return [];
  }

  const style = options.style || {};
  const timing = style.timing || style.segmentation || {};
  const mode = timing.mode || 'word';
  const isWordMode = mode === 'word';
  const idealWords = timing.idealWords || (isWordMode ? 1 : 2);
  const maxWords = timing.maxWords || (isWordMode ? 2 : 3);
  const maxChars = style.typography?.maxCharsPerLine || 16;
  const pauseThreshold = timing.pauseCutThreshold || 0.18;
  const minBeatDuration = timing.minBeatDuration || 0.22;
  const allowSingleWordPunch = timing.allowSingleWordPunch ?? true;
  const allowTwoLineStack = style.layout?.allowTwoLineStack ?? true;
  const punchThreshold = style.emphasis?.punchThreshold || 0.88;

  const beats = [];
  let currentGroup = [];

  const commitBeat = (group, isPunchOverride = false) => {
    if (!group || group.length === 0) return;

    const start = group[0].start;
    const rawEnd = group[group.length - 1].end;
    // Keep timing faithful to speech timestamps
    const end = Math.max(start + minBeatDuration, rawEnd);

    const punchWords = group.filter((w) => w.isPunch);
    const hasPunch = punchWords.length > 0 || isPunchOverride;

    // Composition type classification: strictly "single-word" | "two-word" | "three-word"
    let compositionType = CompositionType.SINGLE_WORD;
    if (group.length === 2) {
      compositionType = CompositionType.TWO_WORD;
    } else if (group.length >= 3) {
      compositionType = CompositionType.THREE_WORD;
    }

    // Line layout: 1 line or balanced 2 lines
    let lines;
    let isStacked = false;
    if (allowTwoLineStack && group.length >= 2) {
      lines = balanceLines(group, maxChars);
      isStacked = lines.length > 1;
    } else {
      lines = [{ words: group }];
    }

    const baseAnim = style.animation || {};
    const isSingleWordPunch = group.length === 1 && hasPunch;

    const animProfile = {
      entrance: isSingleWordPunch ? (baseAnim.punchEntrance || 'pop-scale') : (baseAnim.entrance || 'pop-scale'),
      activeWord: baseAnim.activeWord || 'grow',
      emphasis: isSingleWordPunch
        ? (baseAnim.strongEmphasis || ['grow', 'shake', 'glow'])
        : (hasPunch ? (baseAnim.emphasis || ['grow', 'glow']) : ['grow']),
      growScale: isSingleWordPunch ? (baseAnim.punchGrowScale || 1.14) : (baseAnim.growScale || 1.10),
      shakeIntensity: isSingleWordPunch ? (baseAnim.shakeIntensity || 0.5) : 0,
      exit: baseAnim.exit || 'replace',
    };

    beats.push({
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      words: group,
      lines,
      isStacked,
      isPunch: hasPunch,
      compositionType,
      emphasisWords: group.filter((w) => w.isEmphasis || w.isPunch).map((w) => w.cleanWord),
      animationProfile: animProfile,
    });
  };

  // Word-by-word composition loop
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const isPunch = allowSingleWordPunch && shouldTriggerSingleWordPunch(token, punchThreshold);
    const speechRate = calculateLocalSpeechRate(tokens, i);

    // 1. Climax / Punch word: commit immediately as standalone single-word beat
    // (Except when part of special compound like "BEING REPLACED")
    const nextToken = tokens[i + 1];
    const nextNextToken = tokens[i + 2];
    const isPartOfBeingReplaced =
      token.cleanWord === 'BEING' && nextToken && nextToken.cleanWord === 'REPLACED';

    if (isPunch && !isPartOfBeingReplaced) {
      if (currentGroup.length > 0) {
        commitBeat(currentGroup);
        currentGroup = [];
      }
      commitBeat([token], true);
      i++;
      continue;
    }

    // 2. In word-by-word mode (idealWords === 1)
    if (isWordMode && idealWords === 1) {
      // Check for rare 3-word phrase first
      if (
        maxWords >= 3 &&
        nextToken &&
        nextNextToken &&
        shouldTripleWords(token, nextToken, nextNextToken, speechRate)
      ) {
        commitBeat([token, nextToken, nextNextToken]);
        i += 3;
        continue;
      }

      // Check if this token pairs with nextToken into a 2-word phrase
      if (nextToken && shouldPairWords(token, nextToken, speechRate)) {
        commitBeat([token, nextToken]);
        i += 2;
        continue;
      }

      // Otherwise, emit strictly as 1 word
      commitBeat([token]);
      i++;
      continue;
    }

    // 3. Multi-word beat fallback (for karaoke or custom configurations)
    currentGroup.push(token);

    const hasNaturalPause = token.pauseAfter >= pauseThreshold;
    const isSentenceCut = token.isSentenceEnd;
    const isClauseCut = token.isClauseEnd;
    const currentText = currentGroup.map((w) => w.text).join(' ');
    const isCharLimitReached = currentText.length >= maxChars;
    const isAtIdeal = currentGroup.length >= idealWords;
    const isAtMax = currentGroup.length >= maxWords;
    const isLast = i === tokens.length - 1;

    const cutAtIdeal = isAtIdeal && (hasNaturalPause || isSentenceCut || isClauseCut || isCharLimitReached);

    if (isLast || isAtMax || cutAtIdeal) {
      commitBeat(currentGroup);
      currentGroup = [];
    }

    i++;
  }

  // Smooth replacement: ensure contiguous transitions without overlap or artificial fixed delays
  for (let b = 0; b < beats.length - 1; b++) {
    const cur = beats[b];
    const next = beats[b + 1];

    if (cur.end > next.start) {
      // Clamp end exactly to next beat's start
      cur.end = next.start;
    } else if (next.start - cur.end <= 0.08) {
      // Bridge tiny sub-frame gaps between continuous words to prevent 1-frame black flickering
      cur.end = next.start;
    }
  }

  return beats;
}
