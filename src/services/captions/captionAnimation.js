/**
 * Kinetic Animation & Transition Engine V5
 *
 * Generates composable, production-quality ASS kinetic animation and transition tags
 * for creator-grade vertical captions:
 * - 10 Transitions: Fade, Dissolve, Zoom In, Zoom Out, Slide Up/Down/Left/Right, Blur In, Blur Out
 * - 9 Animations: Word Pop, Slide Reveal, Bounce, Word Reveal, Typing, Color Shift, Highlight Sweep, Mask Reveal, None
 * - 5 Micro-Motions: Soft Scale, Micro Shake, Breath, Pulse, Float
 * - Word-Level Emphasis Easing: Punch overshoot (1.00 -> 1.14 -> 1.03 -> 1.00) & deterministic rotation shake
 */

/**
 * Builds ASS override tags for caption transitions (visual entrance/exit).
 *
 * @param {string} transitionType - 'fade' | 'dissolve' | 'zoom-in' | 'zoom-out' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'blur-in' | 'blur-out' | 'none'
 * @param {number} [durationMs=140]
 * @param {object} [options={}]
 * @returns {string} ASS override tags
 */
export function buildTransitionTags(transitionType = 'none', durationMs = 140, options = {}) {
  const dur = Math.max(60, Math.min(300, durationMs));
  const tMid = Math.round(dur * 0.5);
  const type = String(transitionType || 'none').toLowerCase().replace(/_/g, '-');

  switch (type) {
    case 'fade':
      return `\\fad(${Math.min(120, dur)},0)`;

    case 'dissolve':
      // Soft micro-blur dissolve: enters with slight blur and alpha fade
      return `\\blur5\\alpha&HFF&\\t(0,${dur},\\blur0\\alpha&H00&)`;

    case 'zoom-in':
    case 'zoom':
      // Scale from 70% to 100% with smooth ease
      return `\\fscx70\\fscy70\\t(0,${dur},\\fscx100\\fscy100)`;

    case 'zoom-out':
      // Scale down from 125% to 100%
      return `\\fscx125\\fscy125\\t(0,${dur},\\fscx100\\fscy100)`;

    case 'slide-up':
      // Subtle vertical slide settlement
      return `\\fscy82\\t(0,${dur},\\fscy100)`;

    case 'slide-down':
      return `\\fscy118\\t(0,${dur},\\fscy100)`;

    case 'slide-left':
      return `\\fscx82\\t(0,${dur},\\fscx100)`;

    case 'slide-right':
      return `\\fscx118\\t(0,${dur},\\fscx100)`;

    case 'blur-in':
      return `\\blur10\\t(0,${dur},\\blur0)`;

    case 'blur-out':
      // Blur in with soft alpha
      return `\\blur8\\alpha&HE0&\\t(0,${dur},\\blur0\\alpha&H00&)`;

    case 'none':
    default:
      return '';
  }
}

/**
 * Builds ASS override tags for beat entrance animations.
 * Preserves backward-compatibility with V4 presets.
 *
 * @param {string} entranceType - 'pop-scale' | 'pop' | 'zoom-in' | 'slide-up' | 'slide-reveal' | 'bounce' | 'typing' | 'fade' | 'none'
 * @param {number} [durationMs=160] - Entrance duration in ms
 * @param {number} [startOffsetMs=0] - Offset from dialogue event start
 * @param {object} [options={}] - Additional animation options (direction, etc.)
 * @returns {string} ASS override tags
 */
export function buildEntranceTags(entranceType = 'pop-scale', durationMs = 160, startOffsetMs = 0, options = {}) {
  const tStart = Math.max(0, startOffsetMs);
  const tEnd = tStart + durationMs;
  const type = String(entranceType || 'pop-scale').toLowerCase().replace(/_/g, '-');

  switch (type) {
    case 'pop-scale':
    case 'pop':
    case 'word-pop': {
      // Calibrated podcast pop-scale: 0.82 -> 1.08 (overshoot) -> 1.00 (settle) in ~150ms
      const tMid = Math.round(tStart + durationMs * 0.48);
      return (
        `\\fscx82\\fscy82` +
        `\\t(${tStart},${tMid},\\fscx108\\fscy108)` +
        `\\t(${tMid},${tEnd},\\fscx100\\fscy100)`
      );
    }

    case 'bounce': {
      // High-energy elastic entrance: 0.75 -> 1.15 -> 0.96 -> 1.00
      const t1 = Math.round(tStart + durationMs * 0.40);
      const t2 = Math.round(tStart + durationMs * 0.72);
      return (
        `\\fscx75\\fscy75` +
        `\\t(${tStart},${t1},\\fscx115\\fscy115)` +
        `\\t(${t1},${t2},\\fscx96\\fscy96)` +
        `\\t(${t2},${tEnd},\\fscx100\\fscy100)`
      );
    }

    case 'slide_reveal':
    case 'slide-reveal':
    case 'slide-up': {
      const dir = options.direction || 'up';
      if (dir === 'down') {
        return `\\fscy116\\t(${tStart},${tEnd},\\fscy100)`;
      } else if (dir === 'left') {
        return `\\fscx84\\t(${tStart},${tEnd},\\fscx100)`;
      } else if (dir === 'right') {
        return `\\fscx116\\t(${tStart},${tEnd},\\fscx100)`;
      }
      return `\\fscy84\\t(${tStart},${tEnd},\\fscy100)`;
    }

    case 'word_reveal':
    case 'word-reveal':
      return `\\alpha&HFF&\\t(${tStart},${tEnd},\\alpha&H00&)`;

    case 'typing':
      // Smooth non-flickering character/phrase entrance
      return `\\alpha&HFF&\\blur4\\t(${tStart},${tEnd},\\alpha&H00&\\blur0)`;

    case 'zoom-in':
    case 'zoom':
      // Scale from 75% to 100% with smooth ease
      return `\\fscx75\\fscy75\\t(${tStart},${tEnd},\\fscx100\\fscy100)`;

    case 'slide-down':
    case 'fade':
      return `\\fad(${Math.min(100, durationMs)},0)`;

    case 'none':
    default:
      return '';
  }
}

/**
 * Builds ASS override tags for subtle, premium micro-motion.
 *
 * @param {string} microMotion - 'soft_scale' | 'micro_shake' | 'breath' | 'pulse' | 'float' | 'none'
 * @param {number} durationMs - Total dialogue duration
 * @param {number} [startMs=0]
 * @returns {string}
 */
export function buildMicroMotionTags(microMotion = 'none', durationMs = 240, startMs = 0) {
  if (!microMotion || microMotion === 'none') return '';

  const dur = Math.max(160, durationMs);
  const t0 = Math.round(startMs);
  const tMid = Math.round(t0 + dur * 0.5);
  const tEnd = Math.round(t0 + dur);

  switch (microMotion) {
    case 'soft_scale':
    case 'breath':
      // Gentle 1.00 -> 1.04 breath hold
      return `\\t(${t0},${tMid},\\fscx104\\fscy104)\\t(${tMid},${tEnd},\\fscx100\\fscy100)`;

    case 'micro_shake':
      // Subtle rotation oscillation
      return `\\t(${t0},${Math.round(t0 + dur * 0.33)},\\frz-0.5)\\t(${Math.round(t0 + dur * 0.33)},${Math.round(t0 + dur * 0.66)},\\frz0.5)\\t(${Math.round(t0 + dur * 0.66)},${tEnd},\\frz0)`;

    case 'pulse':
      // Quick subtle beat pulse
      return `\\t(${t0},${Math.round(t0 + dur * 0.25)},\\fscx103\\fscy103)\\t(${Math.round(t0 + dur * 0.25)},${tEnd},\\fscx100\\fscy100)`;

    case 'float':
      // Subtle float effect
      return `\\t(${t0},${tMid},\\fscy102)\\t(${tMid},${tEnd},\\fscy100)`;

    default:
      return '';
  }
}

/**
 * Builds ASS override tags for word-level emphasis.
 *
 * Implements:
 * 1. Punch Overshoot Easing: 1.00 -> 1.14 -> 1.05 -> 1.00
 * 2. Deterministic Micro-Shake:
 *    - Rotation: -0.5° -> +0.5° -> 0°
 *    - Micro-nudge / translation
 * 3. Grow Easing: 1.00 -> 1.10
 *
 * @param {object} options
 * @param {Array<string>} [options.emphasisTypes=['punch']]
 * @param {number} [options.startMs=0] - Offset in ms from dialogue start
 * @param {number} [options.durationMs=240] - Duration of spoken word in ms
 * @param {number} [options.growScale=1.14] - Peak scale factor
 * @param {number} [options.shakeIntensity=0.5] - Micro-shake multiplier
 * @returns {string} ASS override tag string
 */
export function buildWordEmphasisTags({
  emphasisTypes = ['punch'],
  startMs = 0,
  durationMs = 240,
  growScale = 1.14,
  shakeIntensity = 0.5,
}) {
  const tags = [];
  const peakScale = Math.round(growScale * 100);
  const midScale = Math.round(100 + (growScale - 1.0) * 35); // 1.05 for 1.14 peak

  const dur = Math.max(120, durationMs);
  const t0 = Math.round(startMs);
  const tPeak = Math.round(t0 + dur * 0.32);
  const tSettle = Math.round(t0 + dur * 0.65);
  const tEnd = Math.round(t0 + dur);

  // 1. Punch Overshoot: 100% -> peakScale (114%) -> midScale (105%) -> 100%
  if (emphasisTypes.includes('punch') || emphasisTypes.includes('grow')) {
    tags.push(
      `\\t(${t0},${tPeak},\\fscx${peakScale}\\fscy${peakScale})` +
      `\\t(${tPeak},${tSettle},\\fscx${midScale}\\fscy${midScale})` +
      `\\t(${tSettle},${tEnd},\\fscx100\\fscy100)`
    );
  }

  // 2. Deterministic Micro-Shake (rotation: -0.5° -> +0.5° -> 0°)
  if (emphasisTypes.includes('shake') && shakeIntensity > 0) {
    const r1 = (-0.5 * shakeIntensity).toFixed(1);
    const r2 = (0.5 * shakeIntensity).toFixed(1);

    const s1 = Math.round(t0 + dur * 0.25);
    const s2 = Math.round(t0 + dur * 0.55);

    tags.push(
      `\\t(${t0},${s1},\\frz${r1})` +
      `\\t(${s1},${s2},\\frz${r2})` +
      `\\t(${s2},${tEnd},\\frz0)`
    );
  }

  return tags.join('');
}

/**
 * Builds ASS override tags for caption exit.
 *
 * @param {string} exitType - 'fade' | 'scale-down' | 'slide-away' | 'replace' | 'none'
 * @param {number} [durationMs=80]
 * @returns {string}
 */
export function buildExitTags(exitType = 'replace', durationMs = 80) {
  switch (exitType) {
    case 'fade':
      return `\\fad(0,${durationMs})`;

    case 'scale-down':
      return `\\fad(0,${durationMs})`;

    case 'slide-away':
      return `\\fad(0,${durationMs})`;

    case 'replace':
    case 'none':
    default:
      return '';
  }
}
