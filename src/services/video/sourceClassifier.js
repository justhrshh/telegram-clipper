/**
 * Source Classifier
 *
 * Classifies a video source by its resolution, selects an appropriate
 * render master canvas size, and provides caption scaling presets for
 * that canvas — all controlled by the OUTPUT_QUALITY_MODE setting.
 *
 * Quality modes:
 *   auto    — master canvas matches source class (1080p source → 1080p master, no unnecessary upscaling)
 *   maximum — always render at 4K master regardless of source (legacy behavior)
 */

import { getVideoFormat } from '../../config/formats.js';
import { logger } from '../../utils/logger.js';

/**
 * Determines the SourceClass for a given source resolution.
 *
 * Classification is based on the short side of the source (to handle both
 * landscape and portrait inputs uniformly).
 *
 * @param {number} width
 * @param {number} height
 * @returns {'native-4k'|'1440p'|'1080p'|'720p'}
 */
export function getSourceClass(width, height) {
  const shortSide = Math.min(width, height);
  if (shortSide >= 2160) return 'native-4k';
  if (shortSide >= 1440) return '1440p';
  if (shortSide >= 1080) return '1080p';
  return '720p';
}

/**
 * Classifies a source and returns the render plan for the given ratio and quality mode.
 *
 * @param {object} params
 * @param {number} params.width           - Source video width in pixels
 * @param {number} params.height          - Source video height in pixels
 * @param {string} [params.ratio='vertical'] - Target aspect ratio ('vertical'|'horizontal'|'square')
 * @param {string} [params.qualityMode='auto'] - Quality mode ('auto'|'maximum')
 * @param {string} [params.jobId='']      - Job ID for logging context
 *
 * @returns {{
 *   sourceClass: 'native-4k'|'1440p'|'1080p'|'720p',
 *   masterClass: 'native'|'upscaled',
 *   masterWidth: number,
 *   masterHeight: number,
 *   captions: {
 *     fontScale: number,
 *     strokeScale: number,
 *     shadowScale: number,
 *     glowScale: number,
 *     normalizedY: number,
 *     marginV: number,
 *     marginL: number,
 *     marginR: number,
 *     maxCharsPerLine: number,
 *   }
 * }}
 */
export function classifySource({ width, height, ratio = 'vertical', qualityMode = 'auto', jobId = '' }) {
  const format = getVideoFormat(ratio);
  const sourceClass = getSourceClass(width, height);

  let masterDims;
  let captionPreset;

  // Strict policy: Never artificially upscale a 1080p, 1440p, or 720p source to 2160p master
  if (qualityMode === 'maximum' && sourceClass === 'native-4k') {
    masterDims = format.master;
    captionPreset = format.captionsByClass?.['native-4k'] || format.captions;
  } else {
    // Canvas matches source class (1080p source → 1080p master, 1440p source → 1440p master)
    masterDims = format.mastersByClass?.[sourceClass] || format.mastersByClass?.['1080p'] || format.master;
    captionPreset = format.captionsByClass?.[sourceClass] || format.captions;
  }

  const { width: masterWidth, height: masterHeight } = masterDims;

  // masterClass: 'native' if source resolution is at least as large as the master canvas
  // (no upscaling needed), 'upscaled' if the master canvas is larger than the source
  const masterClass = (width >= masterWidth && height >= masterHeight) ? 'native' : 'upscaled';

  logger.info(
    `[${jobId}] [SOURCE_CLASSIFICATION] ` +
    `Source: ${width}×${height} → Class: ${sourceClass} | ` +
    `Mode: ${qualityMode} | Master: ${masterWidth}×${masterHeight} (${masterClass}) | ` +
    `Ratio: ${format.id} | fontScale: ${captionPreset.fontScale}`
  );

  return {
    sourceClass,
    masterClass,
    masterWidth,
    masterHeight,
    captions: {
      fontScale: captionPreset.fontScale,
      strokeScale: captionPreset.strokeScale,
      shadowScale: captionPreset.shadowScale,
      glowScale: captionPreset.glowScale,
      normalizedY: captionPreset.normalizedY,
      marginV: captionPreset.marginV,
      marginL: captionPreset.marginL,
      marginR: captionPreset.marginR,
      maxCharsPerLine: captionPreset.maxCharsPerLine,
    },
  };
}
