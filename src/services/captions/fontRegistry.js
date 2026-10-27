/**
 * Font Registry & Curated Typography System
 *
 * Provides safe creator-grade font registries, style groupings, curated font pairs,
 * weight capabilities, and guaranteed system fallbacks for FFmpeg/libass subtitle rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export const FONT_CATEGORIES = {
  MODERN: 'modern',
  EDITORIAL: 'editorial',
  CONDENSED: 'condensed',
  BOLD_CREATOR: 'bold_creator',
};

/**
 * Curated font definitions with family name, supported weights, category,
 * local asset filenames, and guaranteed native system fallback.
 */
export const FONT_LIBRARY = {
  // Modern
  'Montserrat': {
    id: 'montserrat',
    name: 'Montserrat',
    category: FONT_CATEGORIES.MODERN,
    supportedWeights: ['medium', 'bold', 'extra_bold', 'black'],
    defaultWeight: 'black',
    assetFiles: ['Montserrat-Black.ttf', 'Montserrat-ExtraBold.ttf', 'Montserrat-Bold.ttf'],
    fallback: 'Arial Black',
    description: 'Geometric sans-serif with high punch and ultra-clean geometry',
  },
  'Montserrat Black': {
    id: 'montserrat_black',
    name: 'Montserrat Black',
    category: FONT_CATEGORIES.MODERN,
    supportedWeights: ['black'],
    defaultWeight: 'black',
    assetFiles: ['Montserrat-Black.ttf'],
    fallback: 'Arial Black',
    description: 'Heavy solid geometric sans-serif matching top podcast shorts',
  },
  'Poppins': {
    id: 'poppins',
    name: 'Poppins',
    category: FONT_CATEGORIES.MODERN,
    supportedWeights: ['bold', 'extra_bold'],
    defaultWeight: 'bold',
    assetFiles: ['Poppins-Bold.ttf', 'Poppins-ExtraBold.ttf'],
    fallback: 'Segoe UI Black',
    description: 'Friendly geometric curves with crisp digital presence',
  },
  'Inter': {
    id: 'inter',
    name: 'Inter',
    category: FONT_CATEGORIES.MODERN,
    supportedWeights: ['medium', 'bold', 'extra_bold', 'black'],
    defaultWeight: 'bold',
    assetFiles: ['Inter-Variable.ttf'],
    fallback: 'Segoe UI Bold',
    description: 'Ultra-refined UI grotesk optimized for maximum micro-legibility',
  },

  // Editorial
  'Playfair Display': {
    id: 'playfair_display',
    name: 'Playfair Display',
    category: FONT_CATEGORIES.EDITORIAL,
    supportedWeights: ['bold', 'extra_bold', 'black'],
    defaultWeight: 'bold',
    assetFiles: ['PlayfairDisplay-Variable.ttf'],
    fallback: 'Georgia Bold',
    description: 'High-contrast modern serif with transitional luxury flair',
  },
  'Merriweather': {
    id: 'merriweather',
    name: 'Merriweather',
    category: FONT_CATEGORIES.EDITORIAL,
    supportedWeights: ['bold', 'extra_bold', 'black'],
    defaultWeight: 'bold',
    assetFiles: ['Merriweather-Variable.ttf'],
    fallback: 'Georgia',
    description: 'Warm, sturdy serif designed for effortless storytelling cadence',
  },

  // Condensed
  'Bebas Neue': {
    id: 'bebas_neue',
    name: 'Bebas Neue',
    category: FONT_CATEGORIES.CONDENSED,
    supportedWeights: ['bold', 'extra_bold', 'black'],
    defaultWeight: 'black',
    assetFiles: ['BebasNeue-Regular.ttf'],
    fallback: 'Impact',
    description: 'Tall, punchy condensed uppercase classic for high-energy retention',
  },
  'Oswald': {
    id: 'oswald',
    name: 'Oswald',
    category: FONT_CATEGORIES.CONDENSED,
    supportedWeights: ['bold', 'extra_bold'],
    defaultWeight: 'bold',
    assetFiles: ['Oswald-Variable.ttf'],
    fallback: 'Franklin Gothic Demi Cond',
    description: 'Re-drawing of the classic gothic typeface for modern screens',
  },
  'Anton': {
    id: 'anton',
    name: 'Anton',
    category: FONT_CATEGORIES.CONDENSED,
    supportedWeights: ['black'],
    defaultWeight: 'black',
    assetFiles: ['Anton-Regular.ttf'],
    fallback: 'Impact',
    description: 'Massive heavy condensed display face built for viral impact',
  },

  // Bold / Creator
  'Archivo Black': {
    id: 'archivo_black',
    name: 'Archivo Black',
    category: FONT_CATEGORIES.BOLD_CREATOR,
    supportedWeights: ['black'],
    defaultWeight: 'black',
    assetFiles: ['ArchivoBlack-Regular.ttf'],
    fallback: 'Arial Black',
    description: 'Monolithic grotesque display face with extreme weight presence',
  },
  'Barlow Condensed': {
    id: 'barlow_condensed',
    name: 'Barlow Condensed',
    category: FONT_CATEGORIES.BOLD_CREATOR,
    supportedWeights: ['bold', 'extra_bold', 'black'],
    defaultWeight: 'bold',
    assetFiles: ['BarlowCondensed-Bold.ttf'],
    fallback: 'Franklin Gothic Demi Cond',
    description: 'Slightly rounded, industrial condensed sans with high legibility',
  },
  'League Spartan': {
    id: 'league_spartan',
    name: 'League Spartan',
    category: FONT_CATEGORIES.BOLD_CREATOR,
    supportedWeights: ['bold', 'extra_bold', 'black'],
    defaultWeight: 'extra_bold',
    assetFiles: ['LeagueSpartan-Variable.ttf'],
    fallback: 'Arial Black',
    description: 'Bold geometric statement face based on early twentieth-century design',
  },

  // Guaranteed Native System Fonts
  'Arial Black': {
    id: 'arial_black',
    name: 'Arial Black',
    category: FONT_CATEGORIES.BOLD_CREATOR,
    supportedWeights: ['black'],
    defaultWeight: 'black',
    assetFiles: [],
    fallback: 'Arial',
    description: 'Standard heavy sans with universal compatibility',
  },
  'Impact': {
    id: 'impact',
    name: 'Impact',
    category: FONT_CATEGORIES.CONDENSED,
    supportedWeights: ['black'],
    defaultWeight: 'black',
    assetFiles: [],
    fallback: 'Arial Black',
    description: 'Ultra-condensed heavy headline display standard',
  },
  'Segoe UI Black': {
    id: 'segoe_ui_black',
    name: 'Segoe UI Black',
    category: FONT_CATEGORIES.MODERN,
    supportedWeights: ['extra_bold', 'black'],
    defaultWeight: 'black',
    assetFiles: [],
    fallback: 'Arial Black',
    description: 'Modern Microsoft heavy sans-serif with excellent metrics',
  },
  'Georgia Bold': {
    id: 'georgia_bold',
    name: 'Georgia Bold',
    category: FONT_CATEGORIES.EDITORIAL,
    supportedWeights: ['bold'],
    defaultWeight: 'bold',
    assetFiles: [],
    fallback: 'Times New Roman',
    description: 'Classic high-legibility screen serif',
  },
};

/**
 * Curated font pair presets combining primary (body) and emphasis (punch) fonts.
 */
export const CURATED_FONT_PAIRS = {
  'podcast_classic': {
    id: 'podcast_classic',
    name: '🎙 Podcast Classic',
    primaryFont: 'Montserrat',
    primaryWeight: 'extra_bold',
    emphasisFont: 'Bebas Neue',
    emphasisWeight: 'black',
    tagline: 'Montserrat ExtraBold + Bebas Neue',
    description: 'The definitive podcast short pairing. Wide solid rhythm with punchy condensed climax words.',
  },
  'editorial_chic': {
    id: 'editorial_chic',
    name: '📰 Editorial Chic',
    primaryFont: 'Playfair Display',
    primaryWeight: 'bold',
    emphasisFont: 'Inter',
    emphasisWeight: 'extra_bold',
    tagline: 'Playfair Display + Inter Bold',
    description: 'Sophisticated luxury serif base with crisp modernist emphasis.',
  },
  'modern_tech': {
    id: 'modern_tech',
    name: '⚡ Modern Tech',
    primaryFont: 'Inter',
    primaryWeight: 'extra_bold',
    emphasisFont: 'Montserrat',
    emphasisWeight: 'black',
    tagline: 'Inter ExtraBold + Montserrat Black',
    description: 'Clean Silicon Valley product aesthetic with high visual contrast.',
  },
  'viral_bold': {
    id: 'viral_bold',
    name: '🔥 Viral Bold',
    primaryFont: 'Anton',
    primaryWeight: 'black',
    emphasisFont: 'Montserrat',
    emphasisWeight: 'black',
    tagline: 'Anton + Montserrat Black',
    description: 'Maximum-retention heavy condensed punch for dynamic social content.',
  },
  'cinematic_impact': {
    id: 'cinematic_impact',
    name: '🎬 Cinematic Impact',
    primaryFont: 'Merriweather',
    primaryWeight: 'bold',
    emphasisFont: 'Oswald',
    emphasisWeight: 'bold',
    tagline: 'Merriweather Bold + Oswald Bold',
    description: 'Evocative storytelling serif anchored by muscular gothic accents.',
  },
};

/**
 * Checks if a specific font is actually available on disk (in assets/fonts or Windows system fonts).
 *
 * @param {string} fontName
 * @returns {boolean}
 */
export function isFontAvailable(fontName) {
  if (!fontName) return false;
  const def = FONT_LIBRARY[fontName];
  if (!def) return false;

  // System fonts are always assumed available on Windows
  if (!def.assetFiles || def.assetFiles.length === 0) {
    return true;
  }

  // Check local assets/fonts directory
  const fontsDir = path.resolve('assets/fonts');
  return def.assetFiles.some((f) => {
    const p = path.join(fontsDir, f);
    return fs.existsSync(p) && fs.statSync(p).size > 1000;
  });
}

/**
 * Resolves the effective font family to use in ASS subtitles,
 * applying guaranteed fallback if the font is not installed.
 *
 * @param {string} requestedFont
 * @returns {string} Safe font family name
 */
export function resolveSafeFontFamily(requestedFont, weight = null) {
  if (!requestedFont) return 'Arial Black';

  if ((requestedFont === 'Montserrat' || requestedFont === 'Montserrat Black') && (weight === 'black' || weight === 'heavy' || weight === 900)) {
    if (isFontAvailable('Montserrat Black')) return 'Montserrat Black';
  }

  const def = FONT_LIBRARY[requestedFont];
  if (!def) {
    // If user passed a custom font name not in registry, fallback to Arial Black
    return 'Arial Black';
  }

  if (isFontAvailable(requestedFont)) {
    return def.name;
  }

  logger.warn(`[FONT_FALLBACK] Font '${requestedFont}' unavailable on host. Falling back to '${def.fallback}'`);
  return def.fallback || 'Arial Black';
}

/**
 * Returns available fonts grouped by category.
 *
 * @param {boolean} [onlyAvailable=true]
 * @returns {Record<string, Array<object>>}
 */
export function getFontsByCategory(onlyAvailable = true) {
  const grouped = {
    [FONT_CATEGORIES.MODERN]: [],
    [FONT_CATEGORIES.EDITORIAL]: [],
    [FONT_CATEGORIES.CONDENSED]: [],
    [FONT_CATEGORIES.BOLD_CREATOR]: [],
  };

  for (const [name, def] of Object.entries(FONT_LIBRARY)) {
    const available = isFontAvailable(name);
    if (!onlyAvailable || available) {
      grouped[def.category]?.push({
        name: def.name,
        category: def.category,
        supportedWeights: def.supportedWeights,
        defaultWeight: def.defaultWeight,
        available,
        fallback: def.fallback,
        description: def.description,
      });
    }
  }

  return grouped;
}

/**
 * Validates whether a font weight is supported by a given font.
 * Falls back to the font's default or boldest supported weight.
 *
 * @param {string} fontName
 * @param {string} weight - 'medium' | 'bold' | 'extra_bold' | 'black'
 * @returns {string} Valid weight key
 */
export function resolveSafeFontWeight(fontName, weight) {
  const def = FONT_LIBRARY[fontName] || FONT_LIBRARY['Montserrat'];
  if (def.supportedWeights.includes(weight)) {
    return weight;
  }
  return def.defaultWeight || def.supportedWeights[def.supportedWeights.length - 1];
}

/**
 * Converts a weight key to an integer weight for ASS (e.g. 600, 800, 900).
 *
 * @param {string} weightKey
 * @returns {number}
 */
export function weightKeyToAssWeight(weightKey) {
  switch (weightKey) {
    case 'medium': return 600;
    case 'bold': return 700;
    case 'extra_bold': return 800;
    case 'black':
    case 'heavy': return 900;
    default: return 800;
  }
}
