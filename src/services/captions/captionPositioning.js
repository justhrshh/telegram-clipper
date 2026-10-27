/**
 * Caption Positioning & Safe Regions Coordinator
 *
 * Coordinates vertical alignment and margins on 2160x3840 canvas to guarantee
 * readability and prevent overlap with Reels / Shorts / TikTok UI elements
 * (like/comment buttons, creator name, sound title, progress bar).
 *
 * Prepares extensible interface for future face-tracking / speaker-aware safe zones.
 */

export const CaptionZone = Object.freeze({
  TOP: 'top',
  UPPER_MIDDLE: 'upper-middle',
  CENTER: 'center',
  LOWER_MIDDLE: 'lower-middle',
  BOTTOM_SAFE: 'bottom-safe',
});

// Canvas specifications
export const CANVAS_WIDTH = 2160;
export const CANVAS_HEIGHT = 3840;

// Standard vertical margins (in 4K pixels) for ASS \an alignment tags
const ZONE_METRICS = {
  [CaptionZone.TOP]: {
    alignment: 8, // Top-Center
    marginV: 550, // Safe distance below status bar
    marginL: 100,
    marginR: 100,
    targetY: 650,
  },
  [CaptionZone.UPPER_MIDDLE]: {
    alignment: 2, // Bottom-Center
    marginV: 2400, // Upper third (Y ~ 1440)
    marginL: 100,
    marginR: 100,
    targetY: 1440,
  },
  [CaptionZone.CENTER]: {
    alignment: 5, // Middle-Center
    marginV: 1920,
    marginL: 100,
    marginR: 100,
    targetY: 1920,
  },
  [CaptionZone.LOWER_MIDDLE]: {
    alignment: 2, // Bottom-Center
    marginV: 1300, // Chest-level baseline on 4K vertical (Y ~ 2540, ~0.66 normalized)
    marginL: 120,
    marginR: 120,
    targetY: 2540,
  },
  [CaptionZone.BOTTOM_SAFE]: {
    alignment: 2, // Bottom-Center
    marginV: 750, // Lowest permissible baseline without getting occluded
    marginL: 100,
    marginR: 100,
    targetY: 3090,
  },
};

/**
 * Resolves ASS alignment and margin parameters based on style preset and contextual safe zones.
 *
 * Supports fixed chest-level positioning via normalizedY (e.g. 0.66).
 *
 * @param {object} style - Caption style configuration
 * @param {object} [context]
 * @param {string} [context.preferredZone] - One of CaptionZone values
 * @param {object} [context.format] - Video format configuration from formats.js
 * @param {Array<object>} [context.safeRegions] - Optional bounding boxes for face/subject avoidance
 * @returns {{
 *   alignment: number,
 *   marginV: number,
 *   marginL: number,
 *   marginR: number,
 *   targetY: number,
 *   normalizedX: number,
 *   normalizedY: number,
 *   zone: string
 * }}
 */
export function resolveCaptionPosition(style = {}, context = {}) {
  const layout = style.layout || {};
  const configuredZone = context.preferredZone || layout.zone || layout.anchor || CaptionZone.LOWER_MIDDLE;
  const baseMetrics = ZONE_METRICS[configuredZone] || ZONE_METRICS[CaptionZone.LOWER_MIDDLE];

  const canvasWidth = context.format?.master?.width || CANVAS_WIDTH;
  const canvasHeight = context.format?.master?.height || CANVAS_HEIGHT;
  const formatCaptions = context.format?.captions || null;

  // Normalized vertical placement: format-specific override falls back to style layout or default 0.66
  const normalizedY = formatCaptions?.normalizedY ?? (typeof layout.normalizedY === 'number' ? layout.normalizedY : 0.66);

  // With bottom-center alignment (2), marginV from bottom is canvasHeight * (1 - normalizedY).
  // If an explicit override marginV was provided (already in canvas pixels), use it directly.
  // Otherwise, compute it directly from canvasHeight * (1 - normalizedY).
  const marginV = typeof formatCaptions?.marginV === 'number'
    ? formatCaptions.marginV
    : Math.round(canvasHeight * (1 - normalizedY));

  const alignment = layout.alignment ?? baseMetrics.alignment;
  const marginL = formatCaptions?.marginL ?? layout.marginL ?? baseMetrics.marginL;
  const marginR = formatCaptions?.marginR ?? layout.marginR ?? baseMetrics.marginR;

  const targetY = Math.round(canvasHeight * normalizedY);

  return {
    alignment,
    marginV,
    marginL,
    marginR,
    targetY,
    normalizedX: layout.normalizedX ?? 0.5,
    normalizedY: Math.round((targetY / canvasHeight) * 100) / 100,
    zone: configuredZone,
  };
}
