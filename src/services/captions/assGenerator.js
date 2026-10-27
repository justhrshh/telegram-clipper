/**
 * ASS Subtitle Generator V5 (Creator Studio Edition)
 *
 * Generates broadcast-quality 4K vertical (2160x3840) Advanced SubStation Alpha (.ass)
 * files with:
 * - Dual-font kinetic typography (Primary font for flow, Secondary font for keyword punch)
 * - Curated font fallbacks and weight scaling
 * - Creator-grade transitions: Fade, Dissolve, Zoom, Slide, Blur
 * - Multi-mode animations: Word Pop, Slide Reveal, Typing, Bounce, Word Reveal
 * - Subtle micro-motion: Soft Scale, Micro Shake, Breath, Pulse, Float
 * - Advanced color behavior: Static, One Accent, Word Shift, Beat Shift, Gradient
 * - Synchronized tri-layer rendering (Ghost, Glow Halo, Crisp Foreground)
 */

import fs from 'node:fs/promises';
import {
  buildEntranceTags,
  buildWordEmphasisTags,
  buildExitTags,
  buildTransitionTags,
  buildMicroMotionTags,
} from './captionAnimation.js';
import { resolveCaptionPosition } from './captionPositioning.js';
import { CompositionType } from './podcastComposition.js';
import { getVideoFormat } from '../../config/formats.js';
import { resolveSafeFontFamily, weightKeyToAssWeight } from './fontRegistry.js';

/**
 * Converts standard hex color (#RRGGBB) to ASS color format (&HBBGGRR&).
 *
 * @param {string} hex
 * @returns {string}
 */
export function hexToAssColor(hex) {
  if (!hex || typeof hex !== 'string') return '&HFFFFFF&';
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return '&HFFFFFF&';

  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);

  return `&H${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}&`;
}

/**
 * Converts opacity (0.0 - 1.0) to ASS hex alpha string (&HAA&),
 * where 0x00 is fully opaque and 0xFF is fully transparent.
 *
 * @param {number} opacity
 * @returns {string}
 */
export function opacityToAssAlpha(opacity = 1.0) {
  const clamped = Math.min(1.0, Math.max(0.0, opacity));
  const trans = Math.round((1.0 - clamped) * 255);
  return `&H${trans.toString(16).padStart(2, '0').toUpperCase()}&`;
}

/**
 * Converts decimal seconds into ASS timestamp string (H:MM:SS.cs).
 *
 * @param {number} seconds
 * @returns {string}
 */
export function secondsToAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  const pad = (num, size = 2) => String(num).padStart(size, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Generates an ASS subtitles file from composed editorial beats and style preset.
 *
 * @param {object} options
 * @param {Array<object>} options.beats - Composed editorial beats
 * @param {object} options.style - Caption style preset configuration
 * @param {string} [options.ratio='vertical'] - Aspect ratio identifier
 * @param {object} [options.format] - Optional pre-resolved format configuration
 * @param {string} options.outputPath - Destination filepath
 * @returns {Promise<string>} Output file path
 */
export async function generateAssFile({
  beats = [],
  style,
  ratio = 'vertical',
  format,
  canvasWidth = null,
  canvasHeight = null,
  captionScaleOverride = null,
  outputPath,
}) {
  const formatConfig = format || getVideoFormat(ratio);

  // Caption scaling: use explicit override (source-aware) > format.captions defaults
  const captionScaleSrc = captionScaleOverride || formatConfig.captions || {};
  const captionScale  = captionScaleSrc.fontScale   ?? 1.0;
  const strokeScale   = captionScaleSrc.strokeScale  ?? 1.0;
  const shadowScale   = captionScaleSrc.shadowScale  ?? 1.0;
  const glowScale     = captionScaleSrc.glowScale    ?? 1.0;

  // Canvas resolution: use explicit override (source-aware) > format master dimensions
  const playResX = canvasWidth  ?? formatConfig.master.width;
  const playResY = canvasHeight ?? formatConfig.master.height;

  const typo = style.typography || {};
  const colors = style.colors || {};
  const stroke = style.stroke || {};
  const shadow = style.shadow || {};
  const glow = style.glow || {};
  const transition = style.transition || {};
  const animConfig = style.animation || {};

  // Resolve fonts (Primary & Optional Secondary/Emphasis Font)
  const isDualFont = typo.mode === 'dual' && Boolean(typo.emphasisFont);
  const primaryWeight = typo.primaryWeight || (typeof typo.fontWeight === 'number' && typo.fontWeight >= 800 ? 'black' : 'bold');
  const emphasisWeight = typo.emphasisWeight || primaryWeight;
  const primaryFont = resolveSafeFontFamily(typo.primaryFont || typo.fontFamily || 'Montserrat', primaryWeight);
  const emphasisFont = isDualFont
    ? resolveSafeFontFamily(typo.emphasisFont, emphasisWeight)
    : primaryFont;

  const baseFontSize = typo.fontSize ?? 160;
  const fontSize = Math.round(baseFontSize * captionScale);

  const baseEmphasisSize = typo.emphasisFontSize ?? Math.round(baseFontSize * (style.emphasis?.scale || 1.10));
  const emphasisFontSize = Math.round(baseEmphasisSize * captionScale);

  const primaryWeightAss = typeof typo.fontWeight === 'number'
    ? (typo.fontWeight >= 700 ? -1 : 0)
    : (typo.primaryWeight ? (weightKeyToAssWeight(typo.primaryWeight) >= 700 ? -1 : 0) : -1);

  const emphasisWeightAss = typo.emphasisWeight
    ? (weightKeyToAssWeight(typo.emphasisWeight) >= 700 ? -1 : 0)
    : primaryWeightAss;

  // Resolve caption position using effective format
  const effectiveFormat = captionScaleOverride
    ? { ...formatConfig, captions: { ...formatConfig.captions, ...captionScaleOverride }, master: { width: playResX, height: playResY } }
    : { ...formatConfig, master: { width: playResX, height: playResY } };
  const pos = resolveCaptionPosition(style, { format: effectiveFormat });

  const primaryCol = hexToAssColor(colors.primary || '#FFFFFF');
  const highlightCol = hexToAssColor(colors.highlight || colors.accent || '#00F5FF');
  const secondaryCol = hexToAssColor(colors.secondary || '#D0D0D0');
  const accentPunchCol = hexToAssColor(colors.accent || colors.highlight || '#FFE600');
  const strokeCol = hexToAssColor(stroke.color || '#000000');
  const shadowCol = hexToAssColor(shadow.color || '#000000');
  const shadowAlphaHex = opacityToAssAlpha(shadow.opacity ?? 0.80).replace(/&H|&/g, '');
  const shadowColBaseHex = shadowCol.replace(/&H|&/g, '');
  const styleShadowCol = `&H${shadowAlphaHex}${shadowColBaseHex}&`;

  const glowEnabled = Boolean(glow.enabled);
  const normalGlowCol = hexToAssColor(glow.normalColor || '#FFFFFF');
  const accentGlowCol = hexToAssColor(glow.accentColor || colors.highlight || colors.accent || '#00F5FF');
  const normalGlowAlpha = opacityToAssAlpha(glow.normalOpacity ?? 0.25);
  const accentGlowAlpha = opacityToAssAlpha(glow.accentOpacity ?? 0.70);

  const strokeWidth = (stroke.enabled !== false && (stroke.width ?? 0) > 0)
    ? Math.round(stroke.width * strokeScale)
    : 0;
  const shadowDepth = (shadow.enabled && (shadow.depth ?? 0) > 0)
    ? Math.round(shadow.depth * shadowScale)
    : 0;
  const punchScale = style.emphasis?.strongPunchScale ?? 1.14;

  // Script Header dynamically targeting actual render canvas (source-aware or 4K master)
  const header = `[Script Info]
; Script generated by Telegram Clipper Creator Studio V5
; Ghost-layer kinetic typography: Layer -1 ghost, Layer 0 glow, Layer 1 foreground
Title: Telegram Clipper Studio Captions (${formatConfig.id})
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${primaryFont},${fontSize},${primaryCol},${secondaryCol},${strokeCol},${styleShadowCol},${primaryWeightAss},0,0,0,100,100,${typo.letterSpacing || 0},0,1,${strokeWidth},${shadowDepth},${pos.alignment},${pos.marginL},${pos.marginR},${pos.marginV},1
Style: Punch,${emphasisFont},${Math.round(emphasisFontSize * punchScale)},${highlightCol},${secondaryCol},${strokeCol},${styleShadowCol},${emphasisWeightAss},0,0,0,100,100,${typo.letterSpacing || 0},0,1,${strokeWidth > 0 ? strokeWidth + 2 : 0},${shadowDepth > 0 ? shadowDepth + 2 : 0},${pos.alignment},${pos.marginL},${pos.marginR},${pos.marginV},1
Style: Ghost,${primaryFont},${fontSize},${primaryCol},${secondaryCol},${strokeCol},${styleShadowCol},${primaryWeightAss},0,0,0,100,100,${typo.letterSpacing || 0},0,1,0,0,${pos.alignment},${pos.marginL},${pos.marginR},${pos.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogueLines = [];

  for (let bIdx = 0; bIdx < beats.length; bIdx++) {
    const beat = beats[bIdx];
    const animProfile = beat.animationProfile || {};
    const isKaraoke = animConfig.mode === 'karaoke';

    const beatStartSec = beat.start;
    const beatEndSec = beat.end;
    const beatDurMs = Math.max(120, Math.round((beatEndSec - beatStartSec) * 1000));

    // Karaoke Mode
    if (isKaraoke) {
      for (let wIdx = 0; wIdx < beat.words.length; wIdx++) {
        const activeWord = beat.words[wIdx];
        const nextWord = beat.words[wIdx + 1];
        const wordStartSec = activeWord.start;
        const wordEndSec = nextWord ? Math.min(activeWord.end, nextWord.start) : beatEndSec;

        const startAss = secondsToAssTime(wordStartSec);
        const endAss = secondsToAssTime(Math.max(wordStartSec + 0.05, wordEndSec));

        const formattedLines = beat.lines.map((lineObj) => {
          const lineTokens = lineObj.words.map((item) => {
            const displayText = typo.uppercase ? item.text.toUpperCase() : item.text;
            if (item.cleanWord === activeWord.cleanWord && item.start === activeWord.start) {
              const popTag = buildWordEmphasisTags({
                emphasisTypes: ['grow'],
                startMs: 0,
                durationMs: Math.max(120, Math.round((activeWord.end - activeWord.start) * 1000)),
                growScale: 1.12,
              });
              const fontTag = isDualFont ? `\\fn${emphasisFont}\\fs${emphasisFontSize}` : '';
              return `{${fontTag}\\c${highlightCol}${popTag}}${displayText}{\\rDefault}`;
            } else if (item.start < activeWord.start) {
              return `{\\c${secondaryCol}}${displayText}{\\rDefault}`;
            } else {
              return `{\\c${primaryCol}}${displayText}{\\rDefault}`;
            }
          });
          return lineTokens.join(' ');
        });

        const fullText = formattedLines.join('\\N');
        dialogueLines.push(`Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${fullText}`);
      }
      continue;
    }

    // Word-by-Word & Kinetic Podcast Mode
    const startAss = secondsToAssTime(beatStartSec);
    const endAss = secondsToAssTime(beatEndSec);
    const hasPunch = Boolean(beat.isPunch || beat.words.some((w) => w.isPunch));
    const hasEmphasis = Boolean(hasPunch || beat.words.some((w) => w.isEmphasis));
    const styleName = hasPunch ? 'Punch' : 'Default';

    // 1. Beat-level Transitions & Animations
    let beatGlobalTags = '';

    // Transition tags (e.g. fade, dissolve, zoom-in, slide-up, blur-in)
    if (transition.type && transition.type !== 'none') {
      beatGlobalTags += buildTransitionTags(transition.type, transition.duration || 140);
    }

    // Entrance Animation (word_pop, slide_reveal, bounce, typing, etc.)
    const entranceType = animConfig.type || animProfile.entrance || 'none';
    if (entranceType && entranceType !== 'none') {
      beatGlobalTags += buildEntranceTags(entranceType, 160, 0, {
        direction: animConfig.direction || 'up',
      });
    }

    // Micro-Motion (soft_scale, micro_shake, breath, pulse, float)
    const microMotion = animConfig.microMotion || 'none';
    if (microMotion && microMotion !== 'none') {
      beatGlobalTags += buildMicroMotionTags(microMotion, beatDurMs, 0);
    }

    // Exit Animation
    if (animProfile.exit && animProfile.exit !== 'none') {
      beatGlobalTags += buildExitTags(animProfile.exit, 70);
    }

    // Color behavior resolution
    const colorBehavior = colors.behavior || 'one_accent';

    // Format text lines for foreground layer
    const formattedLines = beat.lines.map((lineObj) => {
      const lineTokens = lineObj.words.map((item, wIndex) => {
        const displayText = typo.uppercase ? item.text.toUpperCase() : item.text;
        const isPunch = Boolean(item.isPunch || (hasPunch && beat.words.length === 1 && item.emphasisScore >= 0.85));
        const isKeyword = Boolean(item.isEmphasis || isPunch);

        // Color behavior logic:
        let wordColor = primaryCol;
        if (colorBehavior === 'static') {
          wordColor = primaryCol;
        } else if (colorBehavior === 'beat_shift') {
          wordColor = bIdx % 2 === 0 ? highlightCol : accentPunchCol;
        } else if (colorBehavior === 'word_shift') {
          wordColor = wIndex % 2 === 0 ? primaryCol : highlightCol;
        } else if (colorBehavior === 'gradient') {
          wordColor = isPunch ? accentPunchCol : (isKeyword ? highlightCol : primaryCol);
        } else {
          // 'one_accent' (default)
          wordColor = isPunch ? accentPunchCol : (isKeyword ? highlightCol : primaryCol);
        }

        const isEmphasized = isKeyword || (style.emphasis?.mode === 'all');

        if (isEmphasized) {
          let wordTags = `\\c${wordColor}`;

          // Dual-font inline switch: use secondary font on emphasis words
          if (isDualFont) {
            wordTags += `\\fn${emphasisFont}\\fs${emphasisFontSize}`;
            if (emphasisWeightAss === -1) wordTags += '\\b1';
          } else if (typo.emphasisSize && typo.emphasisSize !== typo.size) {
            wordTags += `\\fs${emphasisFontSize}`;
          }

          const wordOffsetMs = Math.max(0, Math.round((item.start - beatStartSec) * 1000));
          const wordDurMs = Math.max(120, Math.round((item.end - item.start) * 1000));

          if (animProfile.emphasis && animProfile.emphasis.length > 0) {
            wordTags += buildWordEmphasisTags({
              emphasisTypes: animProfile.emphasis,
              startMs: wordOffsetMs,
              durationMs: wordDurMs,
              growScale: animProfile.growScale || animConfig.growScale || 1.14,
              shakeIntensity: animProfile.shakeIntensity || animConfig.shakeIntensity || 0.4,
            });
          }

          return `{${wordTags}}${displayText}{\\r${styleName}}`;
        } else {
          return `{\\c${primaryCol}}${displayText}{\\r${styleName}}`;
        }
      });

      return lineTokens.join(' ');
    });

    // Plain text representation for ghost layer
    const plainText = beat.lines
      .map((lineObj) => lineObj.words.map((w) => (typo.uppercase ? w.text.toUpperCase() : w.text)).join(' '))
      .join('\\N');

    // -1. Layer -1: Ghost / Echo Layer — only if explicitly enabled
    if (style.ghost?.enabled) {
      const ghostBlur = Math.max(3, Math.round(fontSize / 14));
      const ghostAlpha = '&HA8&';                      // ~34% opaque (subtle, clean depth)
      const ghostOffsetY = Math.max(4, Math.round(fontSize / 12));
      const ghostMarginV = Math.max(0, pos.marginV - ghostOffsetY);
      const ghostTags = `\\blur${ghostBlur}\\be2\\alpha${ghostAlpha}\\c${primaryCol}\\bord0\\shad0`;
      dialogueLines.push(`Dialogue: -1,${startAss},${endAss},Ghost,,${pos.marginL},${pos.marginR},${ghostMarginV},,{${ghostTags}}${plainText}`);
    }

    // 1. Layer 0: Soft Luminous Glow Halo (rendered underneath foreground text)
    if (glowEnabled) {
      const activeGlowCol = hasPunch ? accentPunchCol : (hasEmphasis ? highlightCol : normalGlowCol);
      const resScale = playResX / 2160;
      const glowBorder = Math.max(2, strokeWidth + Math.round((glow.radius || 10) * glowScale * resScale));
      const glowBlur = Math.max(2, Math.round((glow.blur || 10) * glowScale * resScale));

      const entranceDur = 140;
      const startAlpha = hasEmphasis
        ? opacityToAssAlpha(Math.min(1.0, (glow.accentOpacity ?? 0.28) * 1.2))
        : opacityToAssAlpha(Math.min(1.0, (glow.normalOpacity ?? 0.12) * 1.2));
      const settleAlpha = hasEmphasis ? accentGlowAlpha : normalGlowAlpha;

      const glowTags =
        `\\blur${glowBlur}\\bord${glowBorder}\\3c${activeGlowCol}\\3a${startAlpha}\\shad0` +
        `\\t(0,${entranceDur},\\3a${settleAlpha})\\1a&HFF&${beatGlobalTags}`;

      // When dual font is enabled, render formatted lines with font overrides so halo perfectly hugs dual-font glyphs
      const glowContent = isDualFont ? formattedLines.join('\\N') : plainText;
      dialogueLines.push(`Dialogue: 0,${startAss},${endAss},${styleName},,0,0,0,,{${glowTags}}${glowContent}`);
    }

    // 2. Layer 1: Crisp Foreground Text
    const foregroundBlur = strokeWidth > 0 ? 1 : (shadowDepth > 0 ? (shadow.blur ? Math.min(2.0, shadow.blur * 0.5) : 1.2) : 0);
    const foregroundTags = `\\blur${foregroundBlur}\\bord${strokeWidth}\\3c${strokeCol}\\shad${shadowDepth}\\4c${shadowCol}${beatGlobalTags}`;
    const fullForegroundText = `{${foregroundTags}}` + formattedLines.join('\\N');
    const mainLayer = glowEnabled ? 1 : 0;
    dialogueLines.push(`Dialogue: ${mainLayer},${startAss},${endAss},${styleName},,0,0,0,,${fullForegroundText}`);
  }

  const fullAssContent = header + dialogueLines.join('\n') + '\n';
  await fs.writeFile(outputPath, fullAssContent, 'utf8');

  return outputPath;
}
