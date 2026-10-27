/**
 * PRO Caption Studio Engine V5 (Creator Studio Edition)
 *
 * Provides domain models, style catalogues, curated customization options,
 * lightweight preview generators, and deterministic mapping from
 * CaptionStudioConfig down to the ASS generator and rendering engine.
 */

import { getCaptionStyle } from './captionStyles.js';
import {
  FONT_LIBRARY,
  CURATED_FONT_PAIRS,
  FONT_CATEGORIES,
  resolveSafeFontFamily,
  resolveSafeFontWeight,
  weightKeyToAssWeight,
} from './fontRegistry.js';

export { FONT_LIBRARY, CURATED_FONT_PAIRS, FONT_CATEGORIES };

export const TYPOGRAPHY_MODES = {
  single: { label: 'Single Font', desc: 'All words use primary font' },
  dual: { label: 'Dual Font', desc: 'Emphasis words switch to secondary font' },
};

export const STUDIO_STYLES = [
  {
    id: 'podcast-pro',
    name: 'Podcast Pro',
    icon: '🎙',
    tagline: 'Modern creator podcast style',
    description: 'Crisp bold Montserrat typography, vibrant warm orange keyword punch, clean dark drop shadow, and fixed chest-level anchor.',
    defaults: {
      typographyMode: 'dual',
      fontPair: 'podcast_classic',
      primaryFont: 'Montserrat',
      emphasisFont: 'Montserrat',
      primaryWeight: 'black',
      emphasisWeight: 'black',
      size: 'large',
      emphasisSize: 'large',
      weight: 'heavy',
      case: 'uppercase',
      color: 'orange',
      colorBehavior: 'one_accent',
      transition: 'none',
      transitionDuration: 0,
      animation: 'word_pop',
      animationDirection: 'up',
      microMotion: 'none',
      position: 'lower_mid',
      stroke: false,
      glow: false,
      shadow: true,
      softHighlight: false,
      backgroundPlate: false,
      emphasisMode: 'important',
      emphasisTrigger: 'important',
      emphasisStyle: 'color_and_scale',
      emphasisAccent: 'color_and_scale',
    },
  },
  {
    id: 'clean-editorial',
    name: 'Clean Editorial',
    icon: '📰',
    tagline: 'Refined documentary sophistication',
    description: 'Minimalist luxury typography, subtle movement, soft drop shadow, and generous letter spacing with zero visual noise.',
    defaults: {
      typographyMode: 'dual',
      fontPair: 'editorial_chic',
      primaryFont: 'Playfair Display',
      emphasisFont: 'Inter',
      primaryWeight: 'bold',
      emphasisWeight: 'extra_bold',
      size: 'standard',
      emphasisSize: 'large',
      weight: 'bold',
      case: 'uppercase',
      color: 'white',
      colorBehavior: 'static',
      transition: 'dissolve',
      transitionDuration: 140,
      animation: 'typing',
      animationDirection: 'up',
      microMotion: 'none',
      position: 'lower_mid',
      stroke: true,
      glow: false,
      shadow: true,
      softHighlight: true,
      backgroundPlate: false,
      emphasisMode: 'important',
      emphasisTrigger: 'important',
      emphasisStyle: 'font_switch',
      emphasisAccent: 'color_shift',
    },
  },
  {
    id: 'neon-punch',
    name: 'Neon Punch',
    icon: '⚡',
    tagline: 'High-contrast electric vibrancy',
    description: 'High-impact kinetic typography, intense glowing cyan/neon emphasis, punch zoom animation, and deep contrast.',
    defaults: {
      typographyMode: 'dual',
      fontPair: 'modern_tech',
      primaryFont: 'Inter',
      emphasisFont: 'Montserrat',
      primaryWeight: 'extra_bold',
      emphasisWeight: 'black',
      size: 'large',
      emphasisSize: 'hero',
      weight: 'heavy',
      case: 'uppercase',
      color: 'cyan',
      colorBehavior: 'word_shift',
      transition: 'zoom_in',
      transitionDuration: 150,
      animation: 'punch',
      animationDirection: 'up',
      microMotion: 'pulse',
      position: 'lower_mid',
      stroke: true,
      glow: true,
      shadow: true,
      softHighlight: false,
      backgroundPlate: false,
      emphasisMode: 'important',
      emphasisTrigger: 'highlighted',
      emphasisStyle: 'color_font_scale',
      emphasisAccent: 'color_and_scale',
    },
  },
  {
    id: 'viral-pop',
    name: 'Viral Pop',
    icon: '🔥',
    tagline: 'Ultra-fast high-energy impact',
    description: 'Oversized words, rapid scale pops, electric volt lime bloom, and micro-shake on impact words for maximum retention.',
    defaults: {
      typographyMode: 'dual',
      fontPair: 'viral_bold',
      primaryFont: 'Anton',
      emphasisFont: 'Montserrat',
      primaryWeight: 'black',
      emphasisWeight: 'black',
      size: 'massive',
      emphasisSize: 'hero',
      weight: 'heavy',
      case: 'uppercase',
      color: 'lime',
      colorBehavior: 'word_shift',
      transition: 'zoom_in',
      transitionDuration: 140,
      animation: 'bounce',
      animationDirection: 'up',
      microMotion: 'micro_shake',
      position: 'lower_mid',
      stroke: true,
      glow: true,
      shadow: true,
      softHighlight: false,
      backgroundPlate: false,
      emphasisMode: 'all',
      emphasisTrigger: 'beat',
      emphasisStyle: 'color_font_scale',
      emphasisAccent: 'color_and_scale',
    },
  },
  {
    id: 'minimal-pro',
    name: 'Minimal Pro',
    icon: '✨',
    tagline: 'Clean, modern, and unobtrusive',
    description: 'Crisp sans-serif typography, gentle fade entrances, restrained scale transitions, and perfect legibility.',
    defaults: {
      typographyMode: 'single',
      fontPair: null,
      primaryFont: 'Inter',
      emphasisFont: null,
      primaryWeight: 'bold',
      emphasisWeight: null,
      size: 'standard',
      emphasisSize: 'standard',
      weight: 'bold',
      case: 'uppercase',
      color: 'white',
      colorBehavior: 'static',
      transition: 'none',
      transitionDuration: 0,
      animation: 'pop',
      animationDirection: 'up',
      microMotion: 'none',
      position: 'lower_mid',
      stroke: true,
      glow: false,
      shadow: true,
      softHighlight: false,
      backgroundPlate: false,
      emphasisMode: 'none',
      emphasisTrigger: 'important',
      emphasisStyle: 'text_only',
      emphasisAccent: 'scale',
    },
  },
];

export const CINEMATIC_STYLE = {
  id: 'cinematic',
  name: 'Cinematic',
  icon: '🎬',
  tagline: 'Dramatic storytelling elegance',
  description: 'Evocative Merriweather + Oswald typography with slow fade transitions, warm gold highlights, and cinematic presence.',
  defaults: {
    typographyMode: 'dual',
    fontPair: 'cinematic_impact',
    primaryFont: 'Merriweather',
    emphasisFont: 'Oswald',
    primaryWeight: 'bold',
    emphasisWeight: 'bold',
    size: 'standard',
    emphasisSize: 'large',
    weight: 'bold',
    case: 'uppercase',
    color: 'yellow',
    colorBehavior: 'one_accent',
    transition: 'fade',
    transitionDuration: 140,
    animation: 'slide_reveal',
    animationDirection: 'up',
    microMotion: 'soft_scale',
    position: 'lower_mid',
    stroke: true,
    glow: true,
    shadow: true,
    softHighlight: true,
    backgroundPlate: false,
    emphasisMode: 'important',
    emphasisTrigger: 'important',
    emphasisStyle: 'color_font_scale',
    emphasisAccent: 'color_and_scale',
  },
};

export const TYPOGRAPHY_SIZES = {
  compact: { label: 'Compact', fontSize: 135 },
  standard: { label: 'Standard', fontSize: 160 },
  large: { label: 'Large', fontSize: 190 },
  massive: { label: 'Massive', fontSize: 220 },
};

export const EMPHASIS_SIZES = {
  ...TYPOGRAPHY_SIZES,
  hero: { label: 'Hero', fontSize: 245 },
};

export const TYPOGRAPHY_WEIGHTS = {
  medium: { label: 'Medium', fontWeight: 600 },
  bold: { label: 'Bold', fontWeight: 700 },
  heavy: { label: 'Heavy / Black', fontWeight: 900 },
};

export const EXTENDED_WEIGHTS = {
  ...TYPOGRAPHY_WEIGHTS,
  extra_bold: { label: 'ExtraBold', fontWeight: 800 },
  black: { label: 'Black', fontWeight: 900 },
};

export const TEXT_CASES = {
  normal: { label: 'Normal', uppercase: false },
  uppercase: { label: 'UPPERCASE', uppercase: true },
  sentence: { label: 'Sentence', uppercase: false },
};

export const TRANSITION_PRESETS = {
  none: { label: 'None', type: 'none', duration: 0, desc: 'Instant cut' },
  fade: { label: 'Fade', type: 'fade', duration: 120, desc: 'Subtle opacity cross-fade' },
  dissolve: { label: 'Dissolve', type: 'dissolve', duration: 140, desc: 'Smooth micro-blur dissolve' },
  zoom_in: { label: 'Zoom In', type: 'zoom-in', duration: 160, desc: 'Snappy scale-up entrance' },
  zoom_out: { label: 'Zoom Out', type: 'zoom-out', duration: 160, desc: 'Cinematic scale-down settle' },
  slide_up: { label: 'Slide Up', type: 'slide-up', duration: 160, desc: 'Vertical upward motion' },
  slide_down: { label: 'Slide Down', type: 'slide-down', duration: 160, desc: 'Downward drop motion' },
  slide_left: { label: 'Slide Left', type: 'slide-left', duration: 160, desc: 'Lateral leftward motion' },
  slide_right: { label: 'Slide Right', type: 'slide-right', duration: 160, desc: 'Lateral rightward motion' },
  blur_in: { label: 'Blur In', type: 'blur-in', duration: 160, desc: 'Cinematic optical focus-in' },
  blur_out: { label: 'Blur Out', type: 'blur-out', duration: 160, desc: 'Soft defocus transition' },
};

export const ANIMATION_PRESETS = {
  none: {
    label: 'None',
    entrance: 'none',
    mode: 'none',
    growScale: 1.0,
    shakeIntensity: 0,
    desc: 'Static instant appearance',
  },
  word_pop: {
    label: 'Word Pop',
    entrance: 'pop-scale',
    mode: 'keyword',
    growScale: 1.14,
    shakeIntensity: 0.4,
    desc: 'Snappy kinetic pop overshoot',
  },
  slide_reveal: {
    label: 'Slide Reveal',
    entrance: 'slide-reveal',
    mode: 'keyword',
    growScale: 1.08,
    shakeIntensity: 0,
    desc: 'Smooth directional text settlement',
  },
  typing: {
    label: 'Typing',
    entrance: 'typing',
    mode: 'phrase',
    growScale: 1.04,
    shakeIntensity: 0,
    desc: 'Smooth non-flicker progressive entrance',
  },
  bounce: {
    label: 'Bounce',
    entrance: 'bounce',
    mode: 'keyword',
    growScale: 1.15,
    shakeIntensity: 0.5,
    desc: 'High-energy elastic entrance',
  },
  word_reveal: {
    label: 'Word Reveal',
    entrance: 'word-reveal',
    mode: 'keyword',
    growScale: 1.06,
    shakeIntensity: 0,
    desc: 'Progressive word-by-word opacity reveal',
  },
  pop: {
    label: 'Pop',
    entrance: 'pop-scale',
    mode: 'keyword',
    growScale: 1.10,
    shakeIntensity: 0,
    desc: 'Snappy scale-in overshoot',
  },
  fade: {
    label: 'Fade',
    entrance: 'fade',
    mode: 'phrase',
    growScale: 1.05,
    shakeIntensity: 0,
    desc: 'Gentle opacity entrance',
  },
  punch: {
    label: 'Punch',
    entrance: 'pop-scale',
    mode: 'keyword',
    growScale: 1.20,
    shakeIntensity: 0.8,
    desc: 'Climax beat impact zoom',
  },
  slide: {
    label: 'Slide',
    entrance: 'slide-up',
    mode: 'keyword',
    growScale: 1.10,
    shakeIntensity: 0,
    desc: 'Smooth vertical slide-in',
  },
};

export const MICRO_MOTION_PRESETS = {
  none: { label: 'None', desc: 'No micro-movement' },
  soft_scale: { label: 'Soft Scale', desc: 'Subtle 1.04 breathing hold' },
  micro_shake: { label: 'Micro Shake', desc: 'Subtle 0.5° rotation oscillation' },
  breath: { label: 'Breath', desc: 'Gentle organic breathing curve' },
  pulse: { label: 'Pulse', desc: 'Rhythmic audio beat pulse' },
  float: { label: 'Float', desc: 'Subtle vertical float' },
};

export const COLOR_PALETTES = {
  white: {
    label: '⚪ Pure White',
    primary: '#FFFFFF',
    highlight: '#F5F5F5',
    accent: '#E0E0E0',
    glowColor: '#FFFFFF',
  },
  cyan: {
    label: '🔷 Electric Cyan',
    primary: '#FFFFFF',
    highlight: '#00F5FF',
    accent: '#00F5FF',
    glowColor: '#00F5FF',
  },
  yellow: {
    label: '🟡 Electric Gold',
    primary: '#FFFFFF',
    highlight: '#FFE600',
    accent: '#FFE600',
    glowColor: '#FFE600',
  },
  lime: {
    label: '🟢 Volt Lime',
    primary: '#FFFFFF',
    highlight: '#CCFF00',
    accent: '#CCFF00',
    glowColor: '#CCFF00',
  },
  pink: {
    label: '🌸 Neon Pink',
    primary: '#FFFFFF',
    highlight: '#FF2A85',
    accent: '#FF2A85',
    glowColor: '#FF2A85',
  },
  red: {
    label: '🔴 Crimson Punch',
    primary: '#FFFFFF',
    highlight: '#FF2A55',
    accent: '#FF2A55',
    glowColor: '#FF2A55',
  },
  orange: {
    label: '🟠 Warm Orange',
    primary: '#FFFFFF',
    highlight: '#FF9500',
    accent: '#FF7A00',
    glowColor: '#FF9500',
  },
};

export const COLOR_BEHAVIORS = {
  one_accent: { label: 'One Accent', desc: 'White body + highlight color on keywords' },
  word_shift: { label: 'Word Color Shift', desc: 'Word dynamically shifts color on active beat' },
  beat_shift: { label: 'Beat Color Shift', desc: 'Beats alternate accent colors' },
  gradient: { label: 'Gradient-Style Accent', desc: 'Dual-tone keyword and climax punch accents' },
  static: { label: 'Static (Base Only)', desc: 'Uniform color across all words' },
};

export const POSITION_ANCHORS = {
  upper: {
    label: '⬆️ Upper',
    anchor: 'top-center',
    normalizedY: 0.25,
    marginV: 2880,
    desc: 'Upper thirds for talking heads',
  },
  upper_mid: {
    label: '↗️ Upper-Mid',
    anchor: 'upper-mid',
    normalizedY: 0.40,
    marginV: 2304,
    desc: 'Above eye-level safe zone',
  },
  center: {
    label: '⏹ Center',
    anchor: 'center',
    normalizedY: 0.50,
    marginV: 1920,
    desc: 'Direct center frame',
  },
  lower_mid: {
    label: '↘️ Lower-Mid',
    anchor: 'center-chest',
    normalizedY: 0.66,
    marginV: 1306,
    desc: 'Standard podcast chest anchor (Recommended)',
  },
  lower: {
    label: '⬇️ Lower',
    anchor: 'lower',
    normalizedY: 0.80,
    marginV: 768,
    desc: 'Bottom thirds caption bar',
  },
};

export const EMPHASIS_MODES = {
  none: { label: 'None', desc: 'Uniform styling for all words' },
  important: { label: 'Important Words', desc: 'Dynamic pop on key content words' },
  all: { label: 'Every Word', desc: 'High-intensity emphasis on each word' },
};

export const EMPHASIS_TRIGGERS = {
  important: { label: 'Important Words', desc: 'Semantic AI keyword detection' },
  highlighted: { label: 'Highlighted Words', desc: 'Climax & high-energy beats' },
  beat: { label: 'Every Beat', desc: 'Continuous keyword rhythm' },
};

export const EMPHASIS_STYLES = {
  text_only: { label: 'Text Only', desc: 'Plain text without scaling or accent' },
  color_shift: { label: 'Color Shift', desc: 'Accent color change only' },
  font_switch: { label: 'Font Switch', desc: 'Switches to secondary font face' },
  scale: { label: 'Scale', desc: 'Kinetic pop scale only' },
  color_and_font: { label: 'Color + Font', desc: 'Secondary font face + accent color' },
  color_font_scale: { label: 'Color + Font + Scale', desc: 'Full creator punch: Font + Color + Scale' },
};

export const EMPHASIS_ACCENTS = {
  color_shift: { label: 'Color Shift', types: ['glow'] },
  scale: { label: 'Scale', types: ['grow'] },
  color_and_scale: { label: 'Color + Scale', types: ['grow', 'glow'] },
};

/**
 * Returns all 5 studio styles.
 * @returns {Array<object>}
 */
export function listStudioStyles() {
  return STUDIO_STYLES;
}

/**
 * Gets a studio style by ID.
 * @param {string} styleId
 * @returns {object}
 */
export function getStudioStyle(styleId) {
  let cleanId = String(styleId || 'podcast-pro').toLowerCase().trim().replace(/_/g, '-');
  if (cleanId === 'clean') cleanId = 'clean-editorial';
  if (cleanId === 'viral') cleanId = 'viral-pop';
  if (cleanId === 'podcast') cleanId = 'podcast-pro';
  if (cleanId === 'cinematic' || cleanId === 'cinematic-impact') {
    return CINEMATIC_STYLE;
  }
  return STUDIO_STYLES.find((s) => s.id === cleanId) || STUDIO_STYLES[0];
}

/**
 * Creates a default studio configuration for a given style ID.
 *
 * @param {string} [styleId='podcast-pro']
 * @returns {object}
 */
export function createDefaultStudioConfig(styleId = 'podcast-pro') {
  const style = getStudioStyle(styleId);
  return {
    styleId: style.id,
    ...style.defaults,
  };
}

/**
 * Validates and sanitizes a studio config, falling back to safe defaults if malformed.
 * Supports both flat configuration and nested property overrides.
 *
 * @param {object} rawConfig
 * @returns {object}
 */
export function sanitizeStudioConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return createDefaultStudioConfig('podcast-pro');
  }

  const rawStyleId = rawConfig.styleId;
  const matchedStyle = getStudioStyle(rawStyleId);
  const styleId = matchedStyle.id;
  const defaults = matchedStyle.defaults;

  const typoMode = (rawConfig.typographyMode || rawConfig.typography?.mode || defaults.typographyMode);
  const validTypoMode = TYPOGRAPHY_MODES[typoMode] ? typoMode : 'dual';

  const pairKey = (rawConfig.fontPair || rawConfig.typography?.fontPair);
  const validPair = CURATED_FONT_PAIRS[pairKey] ? pairKey : (defaults.fontPair || null);

  const primaryFontRaw = (rawConfig.primaryFont || rawConfig.typography?.primaryFont || defaults.primaryFont || 'Montserrat');
  const safePrimaryFont = resolveSafeFontFamily(primaryFontRaw);

  const emphasisFontRaw = (rawConfig.emphasisFont || rawConfig.typography?.emphasisFont || defaults.emphasisFont || 'Bebas Neue');
  const safeEmphasisFont = validTypoMode === 'dual' ? resolveSafeFontFamily(emphasisFontRaw) : null;

  const sizeKey = (rawConfig.size || rawConfig.typography?.size || defaults.size);
  const safeSize = (TYPOGRAPHY_SIZES[sizeKey] || EMPHASIS_SIZES[sizeKey]) ? sizeKey : defaults.size;

  const emphSizeKey = (rawConfig.emphasisSize || rawConfig.typography?.emphasisSize || defaults.emphasisSize || safeSize);
  const safeEmphasisSize = (EMPHASIS_SIZES[emphSizeKey] || TYPOGRAPHY_SIZES[emphSizeKey]) ? emphSizeKey : safeSize;

  const weightKey = (rawConfig.weight || rawConfig.primaryWeight || rawConfig.typography?.primaryWeight || defaults.primaryWeight || defaults.weight);
  const safeWeight = (TYPOGRAPHY_WEIGHTS[weightKey] || EXTENDED_WEIGHTS[weightKey]) ? weightKey : defaults.weight;

  const emphWeightKey = (rawConfig.emphasisWeight || rawConfig.typography?.emphasisWeight || defaults.emphasisWeight || safeWeight);
  const safeEmphasisWeight = (EXTENDED_WEIGHTS[emphWeightKey] || TYPOGRAPHY_WEIGHTS[emphWeightKey]) ? emphWeightKey : safeWeight;

  const caseKey = (rawConfig.case || rawConfig.typography?.case || defaults.case);
  const safeCase = TEXT_CASES[caseKey] ? caseKey : defaults.case;

  const colorKey = (rawConfig.color || rawConfig.colors?.base || defaults.color);
  const safeColor = COLOR_PALETTES[colorKey] ? colorKey : defaults.color;

  const colorBehavior = (rawConfig.colorBehavior || rawConfig.colors?.behavior || defaults.colorBehavior);
  const safeColorBehavior = COLOR_BEHAVIORS[colorBehavior] ? colorBehavior : defaults.colorBehavior;

  const transKey = (rawConfig.transition || rawConfig.transition?.type || defaults.transition);
  const safeTrans = TRANSITION_PRESETS[transKey] ? transKey : (defaults.transition || 'none');

  const animKey = (rawConfig.animation || rawConfig.animation?.type || defaults.animation);
  const safeAnim = ANIMATION_PRESETS[animKey] ? animKey : defaults.animation;

  const animDir = (rawConfig.animationDirection || rawConfig.animation?.direction || defaults.animationDirection || 'up');
  const safeAnimDir = ['up', 'down', 'left', 'right'].includes(animDir) ? animDir : 'up';

  const microMotion = (rawConfig.microMotion || rawConfig.animation?.microMotion || defaults.microMotion || 'none');
  const safeMicroMotion = MICRO_MOTION_PRESETS[microMotion] ? microMotion : 'none';

  const posKey = (rawConfig.position || defaults.position);
  const safePos = POSITION_ANCHORS[posKey] ? posKey : defaults.position;

  const emphMode = (rawConfig.emphasisMode || defaults.emphasisMode);
  const safeEmphMode = EMPHASIS_MODES[emphMode] ? emphMode : defaults.emphasisMode;

  const emphTrigger = (rawConfig.emphasisTrigger || defaults.emphasisTrigger || 'important');
  const safeEmphTrigger = EMPHASIS_TRIGGERS[emphTrigger] ? emphTrigger : 'important';

  const emphStyle = (rawConfig.emphasisStyle || defaults.emphasisStyle || 'color_font_scale');
  const safeEmphStyle = EMPHASIS_STYLES[emphStyle] ? emphStyle : 'color_font_scale';

  const emphAccent = (rawConfig.emphasisAccent || defaults.emphasisAccent);
  const safeEmphAccent = EMPHASIS_ACCENTS[emphAccent] ? emphAccent : defaults.emphasisAccent;

  return {
    styleId,
    typographyMode: validTypoMode,
    fontPair: validPair,
    primaryFont: safePrimaryFont,
    emphasisFont: safeEmphasisFont,
    primaryWeight: safeWeight,
    emphasisWeight: safeEmphasisWeight,
    size: safeSize,
    emphasisSize: safeEmphasisSize,
    weight: safeWeight,
    case: safeCase,
    color: safeColor,
    colorBehavior: safeColorBehavior,
    transition: safeTrans,
    transitionDuration: rawConfig.transitionDuration || TRANSITION_PRESETS[safeTrans]?.duration || 140,
    animation: safeAnim,
    animationDirection: safeAnimDir,
    microMotion: safeMicroMotion,
    position: safePos,
    stroke: typeof rawConfig.stroke === 'boolean' ? rawConfig.stroke : defaults.stroke,
    glow: typeof rawConfig.glow === 'boolean' ? rawConfig.glow : defaults.glow,
    shadow: typeof rawConfig.shadow === 'boolean' ? rawConfig.shadow : defaults.shadow,
    softHighlight: typeof rawConfig.softHighlight === 'boolean' ? rawConfig.softHighlight : defaults.softHighlight,
    backgroundPlate: typeof rawConfig.backgroundPlate === 'boolean' ? rawConfig.backgroundPlate : defaults.backgroundPlate,
    emphasisMode: safeEmphMode,
    emphasisTrigger: safeEmphTrigger,
    emphasisStyle: safeEmphStyle,
    emphasisAccent: safeEmphAccent,
  };
}

/**
 * Maps a CaptionStudioConfig to an ASS-compatible style object.
 * Reuses underlying base style definitions from captionStyles.js.
 *
 * @param {object} studioConfig
 * @returns {object}
 */
export function mapStudioConfigToStyle(studioConfig) {
  const cfg = sanitizeStudioConfig(studioConfig);
  const baseStyle = getCaptionStyle(cfg.styleId);

  const sizeDef = TYPOGRAPHY_SIZES[cfg.size] || EMPHASIS_SIZES[cfg.size] || TYPOGRAPHY_SIZES.large;
  const emphasisSizeDef = EMPHASIS_SIZES[cfg.emphasisSize] || TYPOGRAPHY_SIZES[cfg.emphasisSize] || sizeDef;
  const weightDef = TYPOGRAPHY_WEIGHTS[cfg.weight] || EXTENDED_WEIGHTS[cfg.weight] || TYPOGRAPHY_WEIGHTS.heavy;
  const caseDef = TEXT_CASES[cfg.case] || TEXT_CASES.uppercase;
  const colorDef = COLOR_PALETTES[cfg.color] || COLOR_PALETTES.cyan;
  const animDef = ANIMATION_PRESETS[cfg.animation] || ANIMATION_PRESETS.word_pop;
  const transDef = TRANSITION_PRESETS[cfg.transition] || TRANSITION_PRESETS.none;
  const posDef = POSITION_ANCHORS[cfg.position] || POSITION_ANCHORS.lower_mid;
  const accentDef = EMPHASIS_ACCENTS[cfg.emphasisAccent] || EMPHASIS_ACCENTS.color_and_scale;

  const emphasisTypes = cfg.emphasisMode === 'none'
    ? []
    : (accentDef?.types || ['grow', 'glow']);

  const mapped = {
    ...baseStyle,
    id: `studio-${cfg.styleId}`,
    name: `${baseStyle.name} (Custom)`,
    typography: {
      ...baseStyle.typography,
      mode: cfg.typographyMode,
      fontFamily: cfg.primaryFont,
      primaryFont: cfg.primaryFont,
      emphasisFont: cfg.emphasisFont,
      fontSize: sizeDef.fontSize,
      emphasisFontSize: emphasisSizeDef.fontSize,
      fontWeight: weightDef.fontWeight,
      primaryWeight: cfg.primaryWeight,
      emphasisWeight: cfg.emphasisWeight,
      uppercase: caseDef.uppercase,
    },
    transition: {
      type: transDef.type,
      duration: cfg.transitionDuration || transDef.duration || 140,
    },
    layout: {
      ...baseStyle.layout,
      anchor: posDef.anchor,
      normalizedY: posDef.normalizedY,
      marginV: posDef.marginV,
    },
    colors: {
      ...baseStyle.colors,
      primary: colorDef.primary,
      highlight: colorDef.highlight,
      accent: colorDef.accent,
      behavior: cfg.colorBehavior,
    },
    stroke: {
      ...baseStyle.stroke,
      enabled: cfg.stroke,
      width: cfg.stroke ? (baseStyle.stroke?.width || 14) : 0,
    },
    shadow: {
      ...baseStyle.shadow,
      enabled: cfg.shadow,
      depth: cfg.shadow ? (baseStyle.shadow?.depth || 8) : 0,
    },
    glow: {
      ...baseStyle.glow,
      enabled: cfg.glow,
      accentColor: colorDef.glowColor,
    },
    emphasis: {
      ...baseStyle.emphasis,
      mode: cfg.emphasisMode === 'none' ? 'none' : 'semantic',
      trigger: cfg.emphasisTrigger,
      style: cfg.emphasisStyle,
      scale: animDef.growScale,
      strongPunchScale: animDef.growScale + 0.06,
    },
    animation: {
      ...baseStyle.animation,
      type: animDef.entrance,
      entrance: animDef.entrance,
      punchEntrance: animDef.entrance,
      direction: cfg.animationDirection,
      microMotion: cfg.microMotion,
      emphasis: emphasisTypes,
      strongEmphasis: animDef.shakeIntensity > 0 ? [...emphasisTypes, 'shake'] : emphasisTypes,
      growScale: animDef.growScale,
      punchGrowScale: animDef.growScale + 0.06,
      shakeIntensity: animDef.shakeIntensity,
    },
  };

  return mapped;
}

/**
 * Generates an instant, lightweight text/ASCII preview card for Telegram.
 * Avoids any expensive FFmpeg/NVENC video encoding while browsing styles.
 *
 * @param {object} studioConfig
 * @returns {string} Formatted Markdown
 */
export function generateLightweightPreview(studioConfig) {
  const cfg = sanitizeStudioConfig(studioConfig);
  const style = getStudioStyle(cfg.styleId);
  const size = (TYPOGRAPHY_SIZES[cfg.size] || EMPHASIS_SIZES[cfg.size])?.label || 'Large';
  const emphSize = (EMPHASIS_SIZES[cfg.emphasisSize] || TYPOGRAPHY_SIZES[cfg.emphasisSize])?.label || size;
  const weight = (TYPOGRAPHY_WEIGHTS[cfg.weight] || EXTENDED_WEIGHTS[cfg.weight])?.label || 'Heavy';
  const cCase = TEXT_CASES[cfg.case]?.label || 'UPPERCASE';
  const color = COLOR_PALETTES[cfg.color]?.label || 'Cyan';
  const colorBeh = COLOR_BEHAVIORS[cfg.colorBehavior]?.label || 'One Accent';
  const anim = ANIMATION_PRESETS[cfg.animation]?.label || 'Word Pop';
  const trans = TRANSITION_PRESETS[cfg.transition]?.label || 'None';
  const micro = MICRO_MOTION_PRESETS[cfg.microMotion]?.label || 'None';
  const pos = POSITION_ANCHORS[cfg.position]?.label || 'Lower-Mid';
  const emph = EMPHASIS_MODES[cfg.emphasisMode]?.label || 'Important';
  const emphStyle = EMPHASIS_STYLES[cfg.emphasisStyle]?.label || 'Color + Font + Scale';

  const effectsList = [];
  if (cfg.stroke) effectsList.push('Stroke');
  if (cfg.glow) effectsList.push('Glow');
  if (cfg.shadow) effectsList.push('Shadow');
  if (cfg.softHighlight) effectsList.push('Soft Highlight');
  if (cfg.backgroundPlate) effectsList.push('Plate');
  const fxDisplay = effectsList.length > 0 ? effectsList.join(' · ') : 'Clean (None)';

  const sampleWord1 = cfg.case === 'uppercase' ? 'THIS IS WHAT' : 'This is what';
  const sampleWord2 = cfg.case === 'uppercase' ? 'THE CAPTION' : 'the caption';
  const sampleWord3 = cfg.case === 'uppercase' ? 'LOOKS LIKE' : 'looks like';

  const fontInfo = cfg.typographyMode === 'dual'
    ? `${cfg.primaryFont} + ${cfg.emphasisFont}`
    : `${cfg.primaryFont} (Single)`;

  return (
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👀 *PREVIEW: ${style.name.toUpperCase()}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💬 *Sample Cadence (1–2 Words):*\n` +
    `\`[ Beat 1 ]\`  _${sampleWord1}_  \`[${cfg.primaryFont}]\`\n` +
    `\`[ Beat 2 ]\`  *${sampleWord2}*  ⚡ \`[${cfg.emphasisFont || cfg.primaryFont} · ${emphSize}]\`\n` +
    `\`[ Beat 3 ]\`  _${sampleWord3}_  \`[${cfg.primaryFont}]\`\n\n` +
    `📍 *Position:* ${pos}\n` +
    `🔤 *Typography:* ${fontInfo} · ${weight} (${size})\n` +
    `🎞 *Transition:* ${trans} (${cfg.transitionDuration}ms)\n` +
    `⚡ *Animation:* ${anim} (Motion: ${micro})\n` +
    `🎨 *Palette:* ${color} (${colorBeh})\n` +
    `✨ *Effects:* ${fxDisplay}\n` +
    `🎯 *Word Emphasis:* ${emph} (${emphStyle})\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`
  );
}
