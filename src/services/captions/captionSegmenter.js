/**
 * Caption Segmenter
 *
 * Intelligently groups raw word-level timestamps into natural, readable,
 * and visually appealing 3-5 word caption phrases.
 */

const PUNCTUATION_BREAK_REGEX = /[.?!,;:]$/;
const STRONG_BREAK_REGEX = /[.?!]$/;

/**
 * Segments an array of raw words with timestamps into structured caption groups.
 *
 * @param {Array<{ word: string, start: number, end: number }>} rawWords
 * @param {object} [options]
 * @param {number} [options.maxWords=4] - Target max words per group
 * @param {number} [options.maxChars=20] - Max character count per line
 * @param {number} [options.pauseThreshold=0.35] - Seconds pause that triggers a break
 * @returns {Array<{ text: string, start: number, end: number, words: Array<object> }>}
 */
export function segmentWords(rawWords = [], options = {}) {
  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    return [];
  }

  const maxWords = options.maxWords || 4;
  const maxChars = options.maxChars || 20;
  const pauseThreshold = options.pauseThreshold || 0.35;

  const segments = [];
  let currentGroup = [];

  for (let i = 0; i < rawWords.length; i++) {
    const wordObj = rawWords[i];
    const cleanedWord = (wordObj.word || '').trim();

    if (!cleanedWord) continue;

    const normalizedWord = {
      word: cleanedWord,
      start: Number(wordObj.start),
      end: Number(wordObj.end),
    };

    if (currentGroup.length === 0) {
      currentGroup.push(normalizedWord);
      continue;
    }

    const prevWord = currentGroup[currentGroup.length - 1];
    const pauseDuration = normalizedWord.start - prevWord.end;
    const currentCharCount = currentGroup.map((w) => w.word).join(' ').length;
    const prospectiveCharCount = currentCharCount + 1 + normalizedWord.word.length;

    const hasStrongPunctuation = STRONG_BREAK_REGEX.test(prevWord.word);
    const hasPunctuationBreak = PUNCTUATION_BREAK_REGEX.test(prevWord.word);
    const isPauseLong = pauseDuration >= pauseThreshold;
    const isWordsLimitReached = currentGroup.length >= maxWords;
    const isCharsLimitExceeded = prospectiveCharCount > maxChars && currentGroup.length >= 2;

    // Remaining words ahead
    const remainingWordsCount = rawWords.length - i;

    // Check if adding this word would orphan the NEXT word (e.g. only 1 word left in a sentence)
    const wouldOrphanNext = remainingWordsCount === 1 && currentGroup.length >= maxWords;

    if (
      hasStrongPunctuation ||
      isPauseLong ||
      (hasPunctuationBreak && currentGroup.length >= 2) ||
      (isWordsLimitReached && !wouldOrphanNext) ||
      isCharsLimitExceeded
    ) {
      // Commit current group
      segments.push(createSegmentFromGroup(currentGroup));
      currentGroup = [normalizedWord];
    } else {
      currentGroup.push(normalizedWord);
    }
  }

  // Flush remaining group
  if (currentGroup.length > 0) {
    // Avoid orphan single word at the very end if previous group can absorb it without huge char overflow
    if (currentGroup.length === 1 && segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      const combinedCharCount = lastSegment.text.length + 1 + currentGroup[0].word.length;
      if (lastSegment.words.length < maxWords + 2 && combinedCharCount <= maxChars + 8) {
        lastSegment.words.push(currentGroup[0]);
        lastSegment.text = lastSegment.words.map((w) => w.word).join(' ');
        lastSegment.end = currentGroup[0].end;
        return segments;
      }
    }
    segments.push(createSegmentFromGroup(currentGroup));
  }

  return segments;
}

function createSegmentFromGroup(group) {
  const text = group.map((w) => w.word).join(' ');
  const start = group[0].start;
  const end = group[group.length - 1].end;

  return {
    text,
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    words: group,
  };
}
