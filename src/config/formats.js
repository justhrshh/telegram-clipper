/**
 * Video Format Registry
 *
 * Centralized registry defining supported video aspect ratios, master resolutions,
 * adaptive delivery ladders, and responsive kinetic caption configuration.
 *
 * Supported formats:
 * - vertical:   9:16  — 2160×3840 (4K), 1440×2560, 1080×1920, 720×1280
 * - horizontal: 16:9  — 3840×2160 (4K), 2560×1440, 1920×1080, 1280×720
 * - square:     1:1   — 2160×2160 (4K), 1440×1440, 1080×1080, 720×720
 *
 * Source-aware quality mode:
 *   AUTO    — master canvas matches source class (1080p source → 1080p master)
 *   MAXIMUM — always render 4K master regardless of source (legacy behavior)
 */

export const VideoRatio = Object.freeze({
  VERTICAL: 'vertical',
  HORIZONTAL: 'horizontal',
  SQUARE: 'square',
});

/**
 * Source class identifiers used by the sourceClassifier.
 */
export const SourceClass = Object.freeze({
  NATIVE_4K: 'native-4k',
  P1440:     '1440p',
  P1080:     '1080p',
  P720:      '720p',
});

export const VIDEO_FORMATS = Object.freeze({
  [VideoRatio.VERTICAL]: {
    id: 'vertical',
    label: 'Vertical 9:16',
    icon: '📱',
    aspectRatioStr: '9:16',
    aspectRatio: 9 / 16,

    /**
     * MAXIMUM mode master (always-4K legacy behavior).
     * Also used as the native-4k master in AUTO mode.
     */
    master: {
      width: 2160,
      height: 3840,
    },

    /**
     * Per-source-class master dimensions (AUTO mode).
     * Key: SourceClass value. Value: { width, height }.
     */
    mastersByClass: {
      'native-4k': { width: 2160, height: 3840 },
      '1440p':     { width: 1440, height: 2560 },
      '1080p':     { width: 1080, height: 1920 },
      '720p':      { width: 720,  height: 1280 },
    },

    /** Delivery ladder for MAXIMUM (4K master) mode */
    deliveryTiers: [
      { id: 'master-4k',    label: '4K master delivered',        width: 2160, height: 3840 },
      { id: 'optimized-4k', label: '4K delivery optimized',      width: 2160, height: 3840 },
      { id: 'delivery-1440',label: '1440p delivery optimized',   width: 1440, height: 2560 },
      { id: 'delivery-1080',label: '1080p delivery optimized',   width: 1080, height: 1920 },
    ],

    /**
     * Caption scaling for 4K master (2160×3840) baseline.
     * Used in MAXIMUM mode and when source is native-4K.
     */
    captions: {
      fontScale: 1.0,
      strokeScale: 1.0,
      shadowScale: 1.0,
      glowScale: 1.0,
      normalizedY: 0.66,
      marginV: 1306,
      marginL: 120,
      marginR: 120,
      maxWidth: 1600,
      maxCharsPerLine: 16,
    },

    /**
     * Per-source-class caption scaling presets (AUTO mode).
     * All values are proportional to 2160×3840 baseline (fontScale=1.0).
     */
    captionsByClass: {
      'native-4k': {
        fontScale: 1.0, strokeScale: 1.0, shadowScale: 1.0, glowScale: 1.0,
        normalizedY: 0.66, marginV: 1306, marginL: 120, marginR: 120,
        maxCharsPerLine: 16,
      },
      '1440p': {
        // Canvas is 1440×2560 → ~0.667× of 4K. Slightly bump font scale for readability.
        fontScale: 0.72, strokeScale: 0.72, shadowScale: 0.72, glowScale: 0.72,
        normalizedY: 0.66,
        marginV: Math.round(2560 * (1 - 0.66)),
        marginL: 80, marginR: 80,
        maxCharsPerLine: 16,
      },
      '1080p': {
        // Canvas is 1080×1920 → 0.5× of 4K.
        fontScale: 0.54, strokeScale: 0.54, shadowScale: 0.54, glowScale: 0.54,
        normalizedY: 0.66,
        marginV: Math.round(1920 * (1 - 0.66)),
        marginL: 60, marginR: 60,
        maxCharsPerLine: 16,
      },
      '720p': {
        // Canvas is 720×1280 → ~0.333× of 4K.
        fontScale: 0.37, strokeScale: 0.37, shadowScale: 0.37, glowScale: 0.37,
        normalizedY: 0.66,
        marginV: Math.round(1280 * (1 - 0.66)),
        marginL: 40, marginR: 40,
        maxCharsPerLine: 14,
      },
    },
  },

  [VideoRatio.HORIZONTAL]: {
    id: 'horizontal',
    label: 'Horizontal 16:9',
    icon: '🖥',
    aspectRatioStr: '16:9',
    aspectRatio: 16 / 9,

    master: {
      width: 3840,
      height: 2160,
    },

    mastersByClass: {
      'native-4k': { width: 3840, height: 2160 },
      '1440p':     { width: 2560, height: 1440 },
      '1080p':     { width: 1920, height: 1080 },
      '720p':      { width: 1280, height: 720  },
    },

    deliveryTiers: [
      { id: 'master-4k',    label: '4K master delivered',        width: 3840, height: 2160 },
      { id: 'optimized-4k', label: '4K delivery optimized',      width: 3840, height: 2160 },
      { id: 'delivery-1440',label: '1440p delivery optimized',   width: 2560, height: 1440 },
      { id: 'delivery-1080',label: '1080p delivery optimized',   width: 1920, height: 1080 },
    ],

    captions: {
      fontScale: 0.72,
      strokeScale: 0.72,
      shadowScale: 0.72,
      glowScale: 0.72,
      normalizedY: 0.75,
      marginV: Math.round(2160 * (1 - 0.75)), // 540
      marginL: 200,
      marginR: 200,
      maxWidth: 2800,
      maxCharsPerLine: 24,
    },

    captionsByClass: {
      'native-4k': {
        fontScale: 0.72, strokeScale: 0.72, shadowScale: 0.72, glowScale: 0.72,
        normalizedY: 0.75,
        marginV: Math.round(2160 * (1 - 0.75)),
        marginL: 200, marginR: 200,
        maxCharsPerLine: 24,
      },
      '1440p': {
        fontScale: 0.50, strokeScale: 0.50, shadowScale: 0.50, glowScale: 0.50,
        normalizedY: 0.75,
        marginV: Math.round(1440 * (1 - 0.75)),
        marginL: 134, marginR: 134,
        maxCharsPerLine: 24,
      },
      '1080p': {
        fontScale: 0.38, strokeScale: 0.38, shadowScale: 0.38, glowScale: 0.38,
        normalizedY: 0.75,
        marginV: Math.round(1080 * (1 - 0.75)),
        marginL: 100, marginR: 100,
        maxCharsPerLine: 22,
      },
      '720p': {
        fontScale: 0.26, strokeScale: 0.26, shadowScale: 0.26, glowScale: 0.26,
        normalizedY: 0.75,
        marginV: Math.round(720 * (1 - 0.75)),
        marginL: 67, marginR: 67,
        maxCharsPerLine: 20,
      },
    },
  },

  [VideoRatio.SQUARE]: {
    id: 'square',
    label: 'Square 1:1',
    icon: '⬜',
    aspectRatioStr: '1:1',
    aspectRatio: 1 / 1,

    master: {
      width: 2160,
      height: 2160,
    },

    mastersByClass: {
      'native-4k': { width: 2160, height: 2160 },
      '1440p':     { width: 1440, height: 1440 },
      '1080p':     { width: 1080, height: 1080 },
      '720p':      { width: 720,  height: 720  },
    },

    deliveryTiers: [
      { id: 'master-4k',    label: '4K master delivered',        width: 2160, height: 2160 },
      { id: 'optimized-4k', label: '4K delivery optimized',      width: 2160, height: 2160 },
      { id: 'delivery-1440',label: '1440p delivery optimized',   width: 1440, height: 1440 },
      { id: 'delivery-1080',label: '1080p delivery optimized',   width: 1080, height: 1080 },
    ],

    captions: {
      fontScale: 0.86,
      strokeScale: 0.86,
      shadowScale: 0.86,
      glowScale: 0.86,
      normalizedY: 0.70,
      marginV: Math.round(2160 * (1 - 0.70)), // 648
      marginL: 150,
      marginR: 150,
      maxWidth: 1800,
      maxCharsPerLine: 18,
    },

    captionsByClass: {
      'native-4k': {
        fontScale: 0.86, strokeScale: 0.86, shadowScale: 0.86, glowScale: 0.86,
        normalizedY: 0.70,
        marginV: Math.round(2160 * (1 - 0.70)),
        marginL: 150, marginR: 150,
        maxCharsPerLine: 18,
      },
      '1440p': {
        fontScale: 0.58, strokeScale: 0.58, shadowScale: 0.58, glowScale: 0.58,
        normalizedY: 0.70,
        marginV: Math.round(1440 * (1 - 0.70)),
        marginL: 100, marginR: 100,
        maxCharsPerLine: 18,
      },
      '1080p': {
        fontScale: 0.44, strokeScale: 0.44, shadowScale: 0.44, glowScale: 0.44,
        normalizedY: 0.70,
        marginV: Math.round(1080 * (1 - 0.70)),
        marginL: 75, marginR: 75,
        maxCharsPerLine: 16,
      },
      '720p': {
        fontScale: 0.30, strokeScale: 0.30, shadowScale: 0.30, glowScale: 0.30,
        normalizedY: 0.70,
        marginV: Math.round(720 * (1 - 0.70)),
        marginL: 50, marginR: 50,
        maxCharsPerLine: 14,
      },
    },
  },
});

export const DEFAULT_VIDEO_FORMAT = VIDEO_FORMATS[VideoRatio.VERTICAL];

/**
 * Resolves a video format configuration by ratio ID.
 * Defaults safely to 'vertical' if formatId is unrecognized.
 *
 * @param {string} [formatId='vertical']
 * @returns {typeof DEFAULT_VIDEO_FORMAT}
 */
export function getVideoFormat(formatId = 'vertical') {
  if (!formatId || typeof formatId !== 'string') {
    return DEFAULT_VIDEO_FORMAT;
  }
  const normalized = formatId.toLowerCase().trim();
  return VIDEO_FORMATS[normalized] || DEFAULT_VIDEO_FORMAT;
}

