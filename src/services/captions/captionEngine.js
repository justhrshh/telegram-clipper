import path from 'node:path';
import { getCaptionStyle, listCaptionStyles } from './captionStyles.js';
import { mapStudioConfigToStyle } from './captionStudio.js';
import { normalizeWords } from './wordNormalizer.js';
import { analyzeEmphasis } from './captionEmphasis.js';
import { composePodcastBeats } from './podcastComposition.js';
import { generateAssFile } from './assGenerator.js';
import { renderCaptionsOntoVideo } from './captionRenderer.js';
import { logger } from '../../utils/logger.js';

export { listCaptionStyles, getCaptionStyle };

/**
 * High-level orchestration for the Podcast Caption Generation & Burning pipeline.
 *
 * Pipeline:
 * raw Whisper word timestamps
 *     ↓
 * normalizeWords (enrich with pauses, punctuation, clause markers)
 *     ↓
 * analyzeEmphasis (multi-signal scoring, intensity levels)
 *     ↓
 * composePodcastBeats (1-4 word pacing, single-word punch, 2-line stacking)
 *     ↓
 * generateAssFile (broadcast 4K ASS with kinetic tags & UI safe-zones)
 *     ↓
 * renderCaptionsOntoVideo (FFmpeg single-pass burning)
 */

/**
 * Generates an optimized ASS subtitles file from transcript words and style preset.
 * Supports source-aware canvas sizing via canvasWidth/canvasHeight/captionScaleOverride.
 *
 * @param {object} options
 * @param {object} options.transcript - Raw or normalized transcript object with words
 * @param {string} [options.styleId='podcast-pro']
 * @param {string} [options.ratio='vertical'] - Aspect ratio format ID
 * @param {number|null} [options.canvasWidth] - Optional canvas width override (source-aware)
 * @param {number|null} [options.canvasHeight] - Optional canvas height override (source-aware)
 * @param {object|null} [options.captionScaleOverride] - Optional per-class caption scaling preset
 * @param {string} options.jobDir - Temporary job directory
 * @param {string} [options.jobId='captions']
 * @returns {Promise<{ assPath: string, style: object, beatCount: number, beats: Array<object> }>}
 */
export async function generateCaptionAss({
  transcript,
  styleId = 'podcast-pro',
  captionConfig = null,
  ratio = 'vertical',
  canvasWidth = null,
  canvasHeight = null,
  captionScaleOverride = null,
  jobDir,
  jobId = 'captions',
}) {
  const style = captionConfig
    ? mapStudioConfigToStyle(captionConfig)
    : getCaptionStyle(styleId);
  const rawWords = transcript?.words || [];

  logger.info(`[${jobId}] Building podcast captions with style '${style.name}' (${style.id}) for ${rawWords.length} words [ratio: ${ratio}, canvas: ${canvasWidth ?? 'default'}×${canvasHeight ?? 'default'}]`);

  // 1. Normalize words with timing and punctuation data
  const normalizedWords = normalizeWords(rawWords);

  // 2. Score emphasis and detect punch words
  const analyzedTokens = analyzeEmphasis(normalizedWords, { mode: style.animation?.mode });

  // 3. Compose into editorial podcast visual beats
  const beats = composePodcastBeats(analyzedTokens, { style });

  logger.info(`[${jobId}] Composed ${normalizedWords.length} words into ${beats.length} editorial podcast beats`);

  // 4. Generate ASS file (canvas-aware)
  const assPath = path.join(jobDir, 'captions.ass');
  await generateAssFile({
    beats,
    style,
    ratio,
    canvasWidth,
    canvasHeight,
    captionScaleOverride,
    outputPath: assPath,
  });

  logger.info(`[${jobId}] Generated ASS subtitles file (${ratio}, ${canvasWidth ?? 'default'}×${canvasHeight ?? 'default'}): ${assPath}`);

  return {
    assPath,
    style,
    beatCount: beats.length,
    beats,
  };
}

/**
 * Builds ASS captions and burns them onto the input video.
 *
 * @param {object} options
 * @param {string} options.videoPath
 * @param {object} options.transcript
 * @param {string} options.styleId
 * @param {string} [options.ratio='vertical']
 * @param {string} options.outputPath
 * @param {string} options.jobDir
 * @param {string} options.jobId
 * @returns {Promise<{ outputPath: string, assPath: string, style: object, beatCount: number }>}
 */
export async function buildAndRenderCaptions({
  videoPath,
  transcript,
  styleId = 'podcast-pro',
  ratio = 'vertical',
  outputPath,
  jobDir,
  jobId = 'captions',
}) {
  const { assPath, style, beatCount } = await generateCaptionAss({
    transcript,
    styleId,
    ratio,
    jobDir,
    jobId,
  });

  await renderCaptionsOntoVideo({
    videoPath,
    assPath,
    outputPath,
    jobId,
  });

  return {
    outputPath,
    assPath,
    style,
    beatCount,
  };
}
