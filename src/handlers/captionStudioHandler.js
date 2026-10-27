/**
 * PRO Caption Studio Handler V5 (Creator Studio Edition)
 *
 * Provides a CapCut/Captions-inspired interactive creator workflow:
 * - Studio Home & Last-Used Style
 * - Style Gallery Carousel (5 curated styles)
 * - Typography (Dual-Font typography, Curated Font Pairs, Font Registry fallbacks, Weights, Sizes)
 * - Transitions (10 transitions: Fade, Dissolve, Zoom In/Out, Slide, Blur In/Out)
 * - Animations (Word Pop, Slide Reveal with direction, Typing, Bounce, Word Reveal)
 * - Micro-Motion (Soft Scale, Micro Shake, Breath, Pulse, Float)
 * - Color Behaviors (Static, One Accent, Word Shift, Beat Shift, Gradient Accent)
 * - Lightweight Previews (Text & Animation breakdown with zero FFmpeg overhead)
 * - Confirmation & Preset Persistence (PostgreSQL user-scoped presets)
 * - PRO entitlement gating with clear upgrade paths
 */

import { Markup } from 'telegraf';
import {
  canUseFeature,
  FEATURE_CAPTION_STUDIO,
  PLAN_PRO,
} from '../services/authService.js';
import {
  STUDIO_STYLES,
  TYPOGRAPHY_SIZES,
  TYPOGRAPHY_WEIGHTS,
  TYPOGRAPHY_MODES,
  TEXT_CASES,
  TRANSITION_PRESETS,
  ANIMATION_PRESETS,
  MICRO_MOTION_PRESETS,
  COLOR_PALETTES,
  COLOR_BEHAVIORS,
  POSITION_ANCHORS,
  EMPHASIS_MODES,
  EMPHASIS_TRIGGERS,
  EMPHASIS_STYLES,
  EMPHASIS_ACCENTS,
  CURATED_FONT_PAIRS,
  FONT_LIBRARY,
  getStudioStyle,
  createDefaultStudioConfig,
  sanitizeStudioConfig,
  generateLightweightPreview,
} from '../services/captions/captionStudio.js';
import {
  saveUserCaptionPreset,
  getUserCaptionPresets,
  getUserCaptionPresetByName,
  deleteUserCaptionPreset,
  getUserLastCaptionConfig,
  saveUserLastCaptionConfig,
} from '../db/captionPresetRepository.js';
import {
  getSession,
  updateSession,
  deleteSession,
  SessionState,
} from '../session/sessionStore.js';
import { isUserBusy, submitClipJob } from '../jobs/jobRunner.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const TELEGRAM_CLIPPER_BUILD = 'v4.2.0-studio-typography';

/**
 * Safely edits the current message or sends a new reply if not editable.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} extra
 */
export async function safeEditMessage(ctx, text, extra = {}) {
  const parseMode = extra.parse_mode || 'Markdown';
  const options = { parse_mode: parseMode, ...extra };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      if (err.message?.includes('message is not modified')) return;
      logger.debug('Failed to editMessageText in studio handler, sending fallback reply:', err.message);
    }
  }

  try {
    await ctx.reply(text, options);
  } catch (err) {
    logger.error('Failed to send studio reply:', err.message);
  }
}

/**
 * Entry point when user selects Captions = YES.
 * Checks PRO entitlement:
 * - FREE users see locked paywall with route to Upgrade to PRO
 * - PRO, OWNER, ADMIN enter Caption Studio
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleStudioEntry(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply('⏱️ This session has expired. Please start again.\n\nSend /clip to start a new clip!');
    return;
  }

  const isPro = await canUseFeature(userId, FEATURE_CAPTION_STUDIO);

  // 1. FREE user: Show high-conversion locked paywall preview
  if (!isPro) {
    const paywallText =
      '⭐ *PRO Caption Studio*\n\n' +
      '🎨 *Design your signature caption language.*\n\n' +
      '• *Dual-Font Typography:* Montserrat + Bebas Neue\n' +
      '• *Transitions:* Fade, Dissolve, Zoom In/Out, Blur In/Out\n' +
      '• *Kinetic Animations:* Word Pop, Slide Reveal, Typing, Bounce\n' +
      '• *Micro-Motion:* Soft Scale, Micro Shake, Beat Pulse\n' +
      '• *Dynamic Palettes:* Cyan, Volt Lime, Electric Gold, Neon Pink\n' +
      '• *Saved Presets:* Save and reuse your unique styles\n\n' +
      'Unlock with PRO to access the complete Caption Studio!';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      [Markup.button.callback('🎬 Standard Captions (Basic)', 'studio_standard_fallback')],
      [Markup.button.callback('❌ Cancel', 'cancel')],
    ]);

    await safeEditMessage(ctx, paywallText, keyboard);
    return;
  }

  // 2. Entitled user (PRO, OWNER, ADMIN): Show high-level style selection only
  const lastConfig = await getUserLastCaptionConfig(userId);
  const initialConfig = lastConfig
    ? sanitizeStudioConfig(lastConfig)
    : createDefaultStudioConfig('podcast-pro');

  updateSession(userId, {
    state: SessionState.CAPTION_STUDIO,
    data: {
      captions: true,
      captionConfig: initialConfig,
    },
  });

  const promptText = 'Choose Caption Style:';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎙 Podcast Pro', 'style_podcast-pro')],
    [Markup.button.callback('📰 Clean', 'style_clean-editorial')],
    [Markup.button.callback('🔥 Viral', 'style_viral-pop')],
    [Markup.button.callback('🎬 Cinematic', 'style_cinematic')],
  ]);

  await safeEditMessage(ctx, promptText, keyboard);
}

/**
 * Standard fallback for FREE users who choose not to upgrade.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleStudioStandardFallback(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply('⏱️ This session has expired. Please start again.\n\nSend /clip to start a new clip!');
    return;
  }

  updateSession(userId, {
    state: SessionState.AWAITING_STYLE,
    data: {
      captions: true,
      captionStyle: 'podcast-pro',
      captionConfig: null,
    },
  });

  const stylesPrompt =
    '🎬 *Standard Captions Selected*\n\n' +
    'Choose a basic caption preset to continue:\n\n' +
    '• *🎙 Podcast Pro* - Crisp white with electric cyan accent\n' +
    '• *🔥 Viral* - Extra-large typography & volt lime\n' +
    '• *⚡ Karaoke* - Word-by-word active tracking\n' +
    '• *💥 Punch* - Crimson red climax words\n' +
    '• *🧼 Clean* - Minimalist editorial elegance';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎙 Podcast Pro', 'style_podcast-pro')],
    [Markup.button.callback('🔥 Viral', 'style_viral')],
    [Markup.button.callback('⚡ Karaoke', 'style_karaoke')],
    [Markup.button.callback('💥 Punch', 'style_punch')],
    [Markup.button.callback('🧼 Clean', 'style_clean')],
    [Markup.button.callback('⭐ Upgrade to PRO Studio', 'upgrade_pro_screen')],
  ]);

  await safeEditMessage(ctx, stylesPrompt, keyboard);
}

/**
 * Renders the Studio Home screen showing the user's active/last-used style.
 *
 * @param {import('telegraf').Context} ctx
 * @param {object} [cfg]
 */
export async function renderStudioHome(ctx, cfg = null) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const studioConfig = cfg || session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const style = getStudioStyle(studioConfig.styleId);
  const fontInfo = studioConfig.typographyMode === 'dual'
    ? `${studioConfig.primaryFont} + ${studioConfig.emphasisFont}`
    : `${studioConfig.primaryFont}`;
  const size = TYPOGRAPHY_SIZES[studioConfig.size]?.label || 'Large';
  const anim = ANIMATION_PRESETS[studioConfig.animation]?.label || 'Word Pop';
  const trans = TRANSITION_PRESETS[studioConfig.transition]?.label || 'None';
  const palette = COLOR_PALETTES[studioConfig.color]?.label || 'Cyan';
  const pos = POSITION_ANCHORS[studioConfig.position]?.label || 'Lower-Mid';

  const text =
    '⭐ *PRO CAPTION STUDIO*\n\n' +
    'Design your signature caption language.\n\n' +
    `*Active Style:*\n` +
    `${style.icon} *${style.name}*\n` +
    `_${style.tagline}_\n\n` +
    `*Profile:*\n` +
    `• 🔤 Typography: ${fontInfo} (${size})\n` +
    `• 🎞 Transition: ${trans}\n` +
    `• ⚡ Animation: ${anim}\n` +
    `• 📍 Position: ${pos}\n` +
    `• 🎨 Palette: ${palette}\n\n` +
    'Select an action below:';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎬 Use This Style', 'studio_confirm')],
    [Markup.button.callback('✨ Customize', 'studio_cust_hub')],
    [Markup.button.callback('🎨 Browse Styles', 'studio_gallery_0')],
    [Markup.button.callback('👀 Preview Style', 'studio_preview')],
    [Markup.button.callback('📂 Saved Presets', 'studio_preset_list')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Renders the Style Gallery carousel card for a specific style index (0-4).
 *
 * @param {import('telegraf').Context} ctx
 * @param {number} rawIndex
 */
export async function renderStudioGallery(ctx, rawIndex = 0) {
  const total = STUDIO_STYLES.length;
  const index = ((rawIndex % total) + total) % total;
  const style = STUDIO_STYLES[index];

  const userId = ctx.from?.id;
  if (userId) {
    const session = getSession(userId);
    if (!session) {
      try {
        await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
      } catch {}
      await safeEditMessage(ctx, '⏱️ *This session has expired after 1 hour of inactivity.*\n\nPlease send /clip to start fresh.');
      return;
    }
    const existingCfg = session?.data?.captionConfig;
    const updatedCfg = existingCfg && existingCfg.styleId === style.id
      ? existingCfg
      : createDefaultStudioConfig(style.id);

    updateSession(userId, {
      data: {
        captionConfig: updatedCfg,
        studioGalleryIndex: index,
      },
    });
  }

  const prevIdx = (index - 1 + total) % total;
  const nextIdx = (index + 1) % total;

  const fontInfo = style.defaults.typographyMode === 'dual'
    ? `${style.defaults.primaryFont} + ${style.defaults.emphasisFont}`
    : `${style.defaults.primaryFont}`;

  const text =
    `🎨 *STYLE GALLERY* (${index + 1}/${total})\n\n` +
    `${style.icon} *${style.name.toUpperCase()}*\n` +
    `_${style.tagline}_\n\n` +
    `${style.description}\n\n` +
    `• *Typography:* ${fontInfo}\n` +
    `• *Transition:* ${TRANSITION_PRESETS[style.defaults.transition]?.label || 'None'}\n` +
    `• *Motion:* ${ANIMATION_PRESETS[style.defaults.animation]?.label}\n` +
    `• *Palette:* ${COLOR_PALETTES[style.defaults.color]?.label}\n` +
    `• *Cadence:* 1–2 words kinetic rhythm`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('◀ Prev', `studio_gallery_${prevIdx}`),
      Markup.button.callback(`✨ ${style.name}`, `studio_select_${style.id}`),
      Markup.button.callback('Next ▶', `studio_gallery_${nextIdx}`),
    ],
    [
      Markup.button.callback('🎬 Select Style', `studio_select_${style.id}`),
      Markup.button.callback('✨ Customize', 'studio_cust_hub'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('📂 Saved Presets', 'studio_preset_list'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Displays the lightweight visual Markdown/ASCII preview.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderStudioPreview(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await safeEditMessage(ctx, '⏱️ *This session has expired after 1 hour of inactivity.*\n\nPlease send /clip to start fresh.');
    return;
  }
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const previewText = generateLightweightPreview(cfg);
  const galleryIdx = session?.data?.studioGalleryIndex ?? 0;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎬 Apply & Continue', 'studio_confirm')],
    [Markup.button.callback('✨ Customize', 'studio_cust_hub')],
    [Markup.button.callback('🎨 Gallery', `studio_gallery_${galleryIdx}`)],
  ]);

  await safeEditMessage(ctx, previewText, keyboard);
}

/**
 * Renders the main Customization Hub screen.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderStudioCustomizeHub(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await safeEditMessage(ctx, '⏱️ *This session has expired after 1 hour of inactivity.*\n\nPlease send /clip to start fresh.');
    return;
  }
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');
  const style = getStudioStyle(cfg.styleId);

  const fontInfo = cfg.typographyMode === 'dual'
    ? `${cfg.primaryFont} + ${cfg.emphasisFont}`
    : `${cfg.primaryFont}`;
  const size = TYPOGRAPHY_SIZES[cfg.size]?.label || 'Large';
  const trans = TRANSITION_PRESETS[cfg.transition]?.label || 'None';
  const anim = ANIMATION_PRESETS[cfg.animation]?.label || 'Word Pop';
  const palette = COLOR_PALETTES[cfg.color]?.label || 'Cyan';
  const pos = POSITION_ANCHORS[cfg.position]?.label || 'Lower-Mid';
  const emphStyle = EMPHASIS_STYLES[cfg.emphasisStyle]?.label || 'Color + Font + Scale';

  const fx = [
    cfg.stroke ? 'Stroke' : null,
    cfg.glow ? 'Glow' : null,
    cfg.shadow ? 'Shadow' : null,
  ].filter(Boolean).join(' · ') || 'None';

  const text =
    '⭐ *CAPTION STUDIO: CUSTOMIZE*\n\n' +
    `*Active Style:* ${style.icon} *${style.name}*\n\n` +
    `*Current Profile:*\n` +
    `• 🔤 Typography: ${fontInfo} (${size})\n` +
    `• 🎞 Transition: ${trans} (${cfg.transitionDuration}ms)\n` +
    `• ⚡ Animation: ${anim} (Motion: ${cfg.microMotion})\n` +
    `• 🎨 Palette: ${palette} (${cfg.colorBehavior})\n` +
    `• 📍 Position: ${pos}\n` +
    `• ✨ Effects: ${fx}\n` +
    `• 🎯 Emphasis: ${emphStyle}\n\n` +
    'Choose an attribute to refine:';

  const galleryIdx = session?.data?.studioGalleryIndex ?? 0;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔤 Typography', 'studio_cust_typo'),
      Markup.button.callback('🎞 Transitions', 'studio_cust_trans'),
    ],
    [
      Markup.button.callback('⚡ Animation', 'studio_cust_anim'),
      Markup.button.callback('🎨 Colors', 'studio_cust_color'),
    ],
    [
      Markup.button.callback('✨ Effects', 'studio_cust_fx'),
      Markup.button.callback('🎯 Word Emphasis', 'studio_cust_emph'),
    ],
    [
      Markup.button.callback('📍 Position', 'studio_cust_pos'),
      Markup.button.callback('👀 Preview', 'studio_preview'),
    ],
    [
      Markup.button.callback('✅ Apply & Continue', 'studio_confirm'),
      Markup.button.callback('🔙 Change Style', `studio_gallery_${galleryIdx}`),
    ],
    [
      Markup.button.callback('💾 Save Preset', 'studio_preset_save_prompt'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Typography
 */
export async function renderCustomizeTypography(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '🔤 *CUSTOMIZE: TYPOGRAPHY*\n\n' +
    `• *Mode:* ${cfg.typographyMode === 'dual' ? 'Dual Font 🔀' : 'Single Font 🔤'}\n` +
    `• *Primary Font:* ${cfg.primaryFont}\n` +
    (cfg.typographyMode === 'dual' ? `• *Emphasis Font:* ${cfg.emphasisFont}\n` : '') +
    `• *Size:* ${TYPOGRAPHY_SIZES[cfg.size]?.label} (Emphasis: ${TYPOGRAPHY_SIZES[cfg.emphasisSize]?.label})\n` +
    `• *Weight:* ${TYPOGRAPHY_WEIGHTS[cfg.weight]?.label}\n\n` +
    'Select an option below:';

  const isDual = cfg.typographyMode === 'dual';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(isDual ? '🔀 Mode: Dual Font' : '🔤 Mode: Single Font', 'studio_set_typomode_toggle'),
      Markup.button.callback('🎭 Curated Pairs', 'studio_typo_pairs'),
    ],
    [
      Markup.button.callback(`🅰️ Font: ${cfg.primaryFont}`, 'studio_typo_pfont'),
      ...(isDual ? [Markup.button.callback(`🅱️ Emph: ${cfg.emphasisFont}`, 'studio_typo_efont')] : []),
    ],
    [
      Markup.button.callback(`${check(cfg.size, 'compact')}Compact`, 'studio_set_size_compact'),
      Markup.button.callback(`${check(cfg.size, 'standard')}Standard`, 'studio_set_size_standard'),
      Markup.button.callback(`${check(cfg.size, 'large')}Large`, 'studio_set_size_large'),
      Markup.button.callback(`${check(cfg.size, 'hero')}Hero`, 'studio_set_size_hero'),
    ],
    [
      Markup.button.callback(`${check(cfg.weight, 'medium')}Medium`, 'studio_set_weight_medium'),
      Markup.button.callback(`${check(cfg.weight, 'bold')}Bold`, 'studio_set_weight_bold'),
      Markup.button.callback(`${check(cfg.weight, 'extra_bold')}ExtraBold`, 'studio_set_weight_extra_bold'),
      Markup.button.callback(`${check(cfg.weight, 'heavy')}Heavy`, 'studio_set_weight_heavy'),
    ],
    [
      Markup.button.callback(`${check(cfg.case, 'normal')}Normal`, 'studio_set_case_normal'),
      Markup.button.callback(`${check(cfg.case, 'uppercase')}UPPERCASE`, 'studio_set_case_uppercase'),
      Markup.button.callback(`${check(cfg.case, 'sentence')}Sentence`, 'studio_set_case_sentence'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Curated Font Pairs
 */
export async function renderCustomizeFontPairs(ctx) {
  const text =
    '🎭 *CURATED FONT PAIRS*\n\n' +
    'Ready-made creator combinations pairing flow and punch typography:';

  const rows = [];
  for (const [key, pair] of Object.entries(CURATED_FONT_PAIRS)) {
    rows.push([Markup.button.callback(pair.name, `studio_set_fontpair_${key}`)]);
  }
  rows.push([Markup.button.callback('🔙 Back to Typography', 'studio_cust_typo')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(rows));
}

/**
 * Customizer Sub-screen: Primary Font Picker
 */
export async function renderCustomizePrimaryFont(ctx) {
  const fonts = ['Montserrat', 'Poppins', 'Inter', 'Playfair Display', 'Merriweather', 'Bebas Neue', 'Oswald', 'Anton', 'Archivo Black', 'Barlow Condensed'];
  const text =
    '🅰️ *CHOOSE PRIMARY FONT*\n\n' +
    'Used for normal spoken cadence:';

  const rows = [];
  for (let i = 0; i < fonts.length; i += 2) {
    const row = [Markup.button.callback(fonts[i], `studio_set_pfont_${fonts[i].toLowerCase().replace(/\s+/g, '_')}`)];
    if (fonts[i + 1]) {
      row.push(Markup.button.callback(fonts[i + 1], `studio_set_pfont_${fonts[i + 1].toLowerCase().replace(/\s+/g, '_')}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('🔙 Back to Typography', 'studio_cust_typo')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(rows));
}

/**
 * Customizer Sub-screen: Emphasis Font Picker
 */
export async function renderCustomizeEmphasisFont(ctx) {
  const fonts = ['Bebas Neue', 'Montserrat', 'Anton', 'Oswald', 'Archivo Black', 'Inter', 'Playfair Display', 'Barlow Condensed', 'Poppins'];
  const text =
    '🅱️ *CHOOSE EMPHASIS FONT*\n\n' +
    'Switched to on important and keyword beats:';

  const rows = [];
  for (let i = 0; i < fonts.length; i += 2) {
    const row = [Markup.button.callback(fonts[i], `studio_set_efont_${fonts[i].toLowerCase().replace(/\s+/g, '_')}`)];
    if (fonts[i + 1]) {
      row.push(Markup.button.callback(fonts[i + 1], `studio_set_efont_${fonts[i + 1].toLowerCase().replace(/\s+/g, '_')}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('🔙 Back to Typography', 'studio_cust_typo')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(rows));
}

/**
 * Customizer Sub-screen: Transitions
 */
export async function renderCustomizeTransitions(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '🎞 *CUSTOMIZE: TRANSITIONS*\n\n' +
    'Control how caption beats enter and exit view with cinema-grade easing:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${check(cfg.transition, 'none')}None`, 'studio_set_trans_none'),
      Markup.button.callback(`${check(cfg.transition, 'fade')}Fade`, 'studio_set_trans_fade'),
      Markup.button.callback(`${check(cfg.transition, 'dissolve')}Dissolve`, 'studio_set_trans_dissolve'),
    ],
    [
      Markup.button.callback(`${check(cfg.transition, 'zoom_in')}Zoom In`, 'studio_set_trans_zoom_in'),
      Markup.button.callback(`${check(cfg.transition, 'zoom_out')}Zoom Out`, 'studio_set_trans_zoom_out'),
    ],
    [
      Markup.button.callback(`${check(cfg.transition, 'slide_up')}Slide Up`, 'studio_set_trans_slide_up'),
      Markup.button.callback(`${check(cfg.transition, 'slide_down')}Slide Down`, 'studio_set_trans_slide_down'),
    ],
    [
      Markup.button.callback(`${check(cfg.transition, 'blur_in')}Blur In`, 'studio_set_trans_blur_in'),
      Markup.button.callback(`${check(cfg.transition, 'blur_out')}Blur Out`, 'studio_set_trans_blur_out'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Animation & Micro-Motion
 */
export async function renderCustomizeAnimation(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '⚡ *CUSTOMIZE: ANIMATION & MOTION*\n\n' +
    `• *Animation:* ${ANIMATION_PRESETS[cfg.animation]?.label}\n` +
    `• *Micro-Motion:* ${MICRO_MOTION_PRESETS[cfg.microMotion]?.label}\n\n` +
    'Select entrance kinetic behavior and subtle micro-movement:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${check(cfg.animation, 'word_pop')}Word Pop`, 'studio_set_anim_word_pop'),
      Markup.button.callback(`${check(cfg.animation, 'slide_reveal')}Slide Reveal`, 'studio_set_anim_slide_reveal'),
    ],
    [
      Markup.button.callback(`${check(cfg.animation, 'typing')}Typing`, 'studio_set_anim_typing'),
      Markup.button.callback(`${check(cfg.animation, 'bounce')}Bounce`, 'studio_set_anim_bounce'),
      Markup.button.callback(`${check(cfg.animation, 'word_reveal')}Word Reveal`, 'studio_set_anim_word_reveal'),
    ],
    [
      Markup.button.callback(`${check(cfg.animation, 'none')}None (Static)`, 'studio_set_anim_none'),
    ],
    [
      Markup.button.callback(`Motion: ${check(cfg.microMotion, 'soft_scale')}Soft Scale`, 'studio_set_micro_soft_scale'),
      Markup.button.callback(`Motion: ${check(cfg.microMotion, 'micro_shake')}Micro Shake`, 'studio_set_micro_micro_shake'),
    ],
    [
      Markup.button.callback(`Motion: ${check(cfg.microMotion, 'pulse')}Pulse`, 'studio_set_micro_pulse'),
      Markup.button.callback(`Motion: ${check(cfg.microMotion, 'none')}None`, 'studio_set_micro_none'),
    ],
    [
      Markup.button.callback('▶ Animation Breakdown', 'studio_anim_preview'),
      Markup.button.callback('👀 Preview', 'studio_preview'),
    ],
    [
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Animation Preview Breakdown
 */
export async function renderStudioAnimationPreview(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const anim = ANIMATION_PRESETS[cfg.animation]?.label || 'Word Pop';
  const micro = MICRO_MOTION_PRESETS[cfg.microMotion]?.label || 'None';

  const text =
    `🎬 *ANIMATION BREAKDOWN: ${anim.toUpperCase()}*\n\n` +
    `• *Cadence:* 1–2 word beats with speech sync\n` +
    `• *Micro-Motion:* ${micro}\n\n` +
    `\`[ 0ms ]\`    Entrance onset with easing curve\n` +
    `\`[ 75ms ]\`   Peak dynamic kinetic pop\n` +
    `\`[ 140ms ]\`  Subtle overshoot settlement\n` +
    `\`[ Hold ]\`   Restrained ${micro.toLowerCase()} visual anchor\n` +
    `\`[ Exit ]\`   Instant cut on next spoken word`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Animation', 'studio_cust_anim')],
    [Markup.button.callback('👀 Visual Preview', 'studio_preview')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Colors & Behaviors
 */
export async function renderCustomizeColors(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '🎨 *CUSTOMIZE: COLOR & BEHAVIOR*\n\n' +
    `• *Palette:* ${COLOR_PALETTES[cfg.color]?.label}\n` +
    `• *Behavior:* ${COLOR_BEHAVIORS[cfg.colorBehavior]?.label}\n\n` +
    'Select high-contrast palette and dynamic keyword color shift behavior:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${check(cfg.color, 'white')}⚪ Pure White`, 'studio_set_color_white'),
      Markup.button.callback(`${check(cfg.color, 'cyan')}🔷 Cyan`, 'studio_set_color_cyan'),
    ],
    [
      Markup.button.callback(`${check(cfg.color, 'yellow')}🟡 Gold`, 'studio_set_color_yellow'),
      Markup.button.callback(`${check(cfg.color, 'lime')}🟢 Volt Lime`, 'studio_set_color_lime'),
    ],
    [
      Markup.button.callback(`${check(cfg.color, 'pink')}🌸 Neon Pink`, 'studio_set_color_pink'),
      Markup.button.callback(`${check(cfg.color, 'red')}🔴 Crimson`, 'studio_set_color_red'),
    ],
    [
      Markup.button.callback(`${check(cfg.colorBehavior, 'one_accent')}One Accent`, 'studio_set_colorbeh_one_accent'),
      Markup.button.callback(`${check(cfg.colorBehavior, 'word_shift')}Word Shift`, 'studio_set_colorbeh_word_shift'),
    ],
    [
      Markup.button.callback(`${check(cfg.colorBehavior, 'gradient')}Gradient Accent`, 'studio_set_colorbeh_gradient'),
      Markup.button.callback(`${check(cfg.colorBehavior, 'static')}Static`, 'studio_set_colorbeh_static'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Position
 */
export async function renderCustomizePosition(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '📍 *CUSTOMIZE: POSITION ANCHOR*\n\n' +
    'Position captions accurately relative to speaker faces and safe zones:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${check(cfg.position, 'upper')}⬆️ Upper`, 'studio_set_pos_upper'),
      Markup.button.callback(`${check(cfg.position, 'upper_mid')}↗️ Upper-Mid`, 'studio_set_pos_upper_mid'),
    ],
    [
      Markup.button.callback(`${check(cfg.position, 'center')}⏹ Center`, 'studio_set_pos_center'),
      Markup.button.callback(`${check(cfg.position, 'lower_mid')}↘️ Lower-Mid (Chest)`, 'studio_set_pos_lower_mid'),
    ],
    [
      Markup.button.callback(`${check(cfg.position, 'lower')}⬇️ Lower`, 'studio_set_pos_lower'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Effects
 */
export async function renderCustomizeEffects(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const onOff = (val) => (val ? '🟢 ON' : '⚪ OFF');

  const text =
    '✨ *CUSTOMIZE: EFFECTS*\n\n' +
    'Toggle visual treatment layers to enhance readability and style:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Stroke: ${onOff(cfg.stroke)}`, 'studio_set_fx_stroke'),
      Markup.button.callback(`Glow: ${onOff(cfg.glow)}`, 'studio_set_fx_glow'),
    ],
    [
      Markup.button.callback(`Shadow: ${onOff(cfg.shadow)}`, 'studio_set_fx_shadow'),
      Markup.button.callback(`Soft Highlight: ${onOff(cfg.softHighlight)}`, 'studio_set_fx_softHighlight'),
    ],
    [
      Markup.button.callback(`Plate: ${onOff(cfg.backgroundPlate)}`, 'studio_set_fx_backgroundPlate'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Customizer Sub-screen: Word Emphasis
 */
export async function renderCustomizeEmphasis(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');

  const check = (val, target) => (val === target ? '✓ ' : '');

  const text =
    '🎯 *CUSTOMIZE: WORD EMPHASIS*\n\n' +
    `• *Trigger:* ${EMPHASIS_TRIGGERS[cfg.emphasisTrigger]?.label || 'Important Words'}\n` +
    `• *Treatment:* ${EMPHASIS_STYLES[cfg.emphasisStyle]?.label || 'Color + Font + Scale'}\n\n` +
    'Control dynamic keyword pop, dual-font switching, and accent scale behaviors:';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${check(cfg.emphasisTrigger, 'important')}Important Words`, 'studio_set_emphtrigger_important'),
      Markup.button.callback(`${check(cfg.emphasisTrigger, 'highlighted')}Climax Beats`, 'studio_set_emphtrigger_highlighted'),
      Markup.button.callback(`${check(cfg.emphasisTrigger, 'beat')}Every Beat`, 'studio_set_emphtrigger_beat'),
    ],
    [
      Markup.button.callback(`${check(cfg.emphasisStyle, 'color_font_scale')}Color + Font + Scale`, 'studio_set_emphstyle_color_font_scale'),
      Markup.button.callback(`${check(cfg.emphasisStyle, 'color_and_font')}Color + Font`, 'studio_set_emphstyle_color_and_font'),
    ],
    [
      Markup.button.callback(`${check(cfg.emphasisStyle, 'color_shift')}Color Shift`, 'studio_set_emphstyle_color_shift'),
      Markup.button.callback(`${check(cfg.emphasisStyle, 'font_switch')}Font Switch`, 'studio_set_emphstyle_font_switch'),
      Markup.button.callback(`${check(cfg.emphasisStyle, 'scale')}Scale`, 'studio_set_emphstyle_scale'),
    ],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('🔙 Back to Studio', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Handles single-click attribute modifications in the customizer.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} action
 */
export async function handleStudioSetAction(ctx, action) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await safeEditMessage(ctx, '⏱️ *This session has expired after 1 hour of inactivity.*\n\nPlease send /clip to start fresh.');
    return;
  }

  const cfg = session.data.captionConfig || createDefaultStudioConfig('podcast-pro');

  if (action === 'typomode_toggle') {
    cfg.typographyMode = cfg.typographyMode === 'dual' ? 'single' : 'dual';
    if (cfg.typographyMode === 'dual' && !cfg.emphasisFont) {
      cfg.emphasisFont = 'Bebas Neue';
    }
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('fontpair_')) {
    const pairKey = action.replace('fontpair_', '');
    const pair = CURATED_FONT_PAIRS[pairKey];
    if (pair) {
      cfg.typographyMode = 'dual';
      cfg.fontPair = pair.id;
      cfg.primaryFont = pair.primaryFont;
      cfg.primaryWeight = pair.primaryWeight;
      cfg.emphasisFont = pair.emphasisFont;
      cfg.emphasisWeight = pair.emphasisWeight;
    }
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('pfont_')) {
    const fontKey = action.replace('pfont_', '');
    const fontEntry = Object.keys(FONT_LIBRARY).find((k) => k.toLowerCase().replace(/\s+/g, '_') === fontKey);
    if (fontEntry) {
      cfg.primaryFont = fontEntry;
    }
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('efont_')) {
    const fontKey = action.replace('efont_', '');
    const fontEntry = Object.keys(FONT_LIBRARY).find((k) => k.toLowerCase().replace(/\s+/g, '_') === fontKey);
    if (fontEntry) {
      cfg.emphasisFont = fontEntry;
      cfg.typographyMode = 'dual';
    }
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('size_')) {
    cfg.size = action.replace('size_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('weight_')) {
    cfg.weight = action.replace('weight_', '');
    cfg.primaryWeight = cfg.weight;
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('case_')) {
    cfg.case = action.replace('case_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTypography(ctx);
  } else if (action.startsWith('trans_')) {
    cfg.transition = action.replace('trans_', '');
    cfg.transitionDuration = TRANSITION_PRESETS[cfg.transition]?.duration || 140;
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeTransitions(ctx);
  } else if (action.startsWith('anim_')) {
    cfg.animation = action.replace('anim_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeAnimation(ctx);
  } else if (action.startsWith('micro_')) {
    cfg.microMotion = action.replace('micro_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeAnimation(ctx);
  } else if (action.startsWith('color_')) {
    cfg.color = action.replace('color_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeColors(ctx);
  } else if (action.startsWith('colorbeh_')) {
    cfg.colorBehavior = action.replace('colorbeh_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeColors(ctx);
  } else if (action.startsWith('pos_')) {
    cfg.position = action.replace('pos_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizePosition(ctx);
  } else if (action.startsWith('fx_')) {
    const fxName = action.replace('fx_', '');
    cfg[fxName] = !cfg[fxName];
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeEffects(ctx);
  } else if (action.startsWith('emphtrigger_')) {
    cfg.emphasisTrigger = action.replace('emphtrigger_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeEmphasis(ctx);
  } else if (action.startsWith('emphstyle_')) {
    cfg.emphasisStyle = action.replace('emphstyle_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeEmphasis(ctx);
  } else if (action.startsWith('emphmode_')) {
    cfg.emphasisMode = action.replace('emphmode_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeEmphasis(ctx);
  } else if (action.startsWith('emphaccent_')) {
    cfg.emphasisAccent = action.replace('emphaccent_', '');
    updateSession(userId, { data: { captionConfig: cfg } });
    await renderCustomizeEmphasis(ctx);
  }
}

/**
 * Renders the Confirmation Screen before applying the style and rendering.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderStudioConfirm(ctx) {
  const userId = ctx.from?.id;
  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await safeEditMessage(ctx, '⏱️ *This session has expired after 1 hour of inactivity.*\n\nPlease send /clip to start fresh.');
    return;
  }
  const cfg = session?.data?.captionConfig || createDefaultStudioConfig('podcast-pro');
  const style = getStudioStyle(cfg.styleId);

  const fontInfo = cfg.typographyMode === 'dual'
    ? `${cfg.primaryFont} + ${cfg.emphasisFont}`
    : `${cfg.primaryFont}`;
  const size = TYPOGRAPHY_SIZES[cfg.size]?.label || 'Large';
  const anim = ANIMATION_PRESETS[cfg.animation]?.label || 'Word Pop';
  const trans = TRANSITION_PRESETS[cfg.transition]?.label || 'None';
  const pos = POSITION_ANCHORS[cfg.position]?.label || 'Lower-Mid';
  const palette = COLOR_PALETTES[cfg.color]?.label || 'Cyan';

  const fxList = [];
  if (cfg.stroke) fxList.push('Stroke');
  if (cfg.glow) fxList.push('Glow');
  if (cfg.shadow) fxList.push('Shadow');
  const fxDisplay = fxList.join(' · ') || 'None';

  const text =
    '⭐ *CONFIRM CAPTION STYLE*\n\n' +
    'Your custom caption profile is ready:\n\n' +
    `• *Style:* ${style.icon} ${style.name}\n` +
    `• *Typography:* ${fontInfo} (${size})\n` +
    `• *Transition:* ${trans}\n` +
    `• *Motion:* ${anim} (Micro: ${cfg.microMotion})\n` +
    `• *Position:* ${pos}\n` +
    `• *Palette:* ${palette} (${cfg.colorBehavior})\n` +
    `• *Effects:* ${fxDisplay}\n\n` +
    'Burn kinetic captions and export clip?';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Apply & Continue', 'studio_apply')],
    [
      Markup.button.callback('👀 Preview', 'studio_preview'),
      Markup.button.callback('✏️ Customize', 'studio_cust_hub'),
    ],
    [
      Markup.button.callback('💾 Save Preset', 'studio_preset_save_prompt'),
      Markup.button.callback('🔙 Back', 'studio_cust_hub'),
    ],
  ]);

  await safeEditMessage(ctx, text, keyboard);
}

/**
 * Handles applying the studio configuration and submitting the background render job.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleStudioApply(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  if (isUserBusy(userId)) {
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const session = getSession(userId);
  if (!session || !session.data) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply('⏱️ This session has expired. Please start again.\n\nSend /clip to start a new request!');
    return;
  }

  const { url, startTime, endTime, ratio, presentation } = session.data;
  const studioConfig = sanitizeStudioConfig(session.data.captionConfig);
  const selectedRatio = ratio || 'vertical';
  const selectedPresentation = presentation || 'standard';

  // Persist user's last-used configuration in PostgreSQL asynchronously
  saveUserLastCaptionConfig(userId, studioConfig).catch((err) => {
    logger.warn(`Failed to save last_caption_config for user ${userId}:`, err.message);
  });

  // Clear session so user cannot re-trigger while processing
  deleteSession(userId);

  logger.info(
    `[User ${userId}] [DISPATCH_STUDIO_JOB] [${TELEGRAM_CLIPPER_BUILD}] Dispatching clip job for ${url} ` +
    `[${startTime}-${endTime}] [format: ${selectedRatio}] [presentation: ${selectedPresentation}] [studioStyle: ${studioConfig.styleId}]`
  );

  let statusMessage;
  try {
    statusMessage = await ctx.reply(`🎬 Starting your clip request with custom captions... [${TELEGRAM_CLIPPER_BUILD}]`);
  } catch (err) {
    logger.error(`[User ${userId}] Failed to send initial status message:`, err);
  }

  submitClipJob({
    telegram: ctx.telegram,
    jobData: {
      userId,
      chatId,
      url,
      startTime,
      endTime,
      ratio: selectedRatio,
      presentation: selectedPresentation,
      captions: true,
      captionStyle: studioConfig.styleId,
      captionConfig: studioConfig,
      statusMessageId: statusMessage?.message_id,
    },
  });
}

/**
 * Handles prompt to save active configuration as a named preset.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleStudioPresetSavePrompt(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session) {
    try {
      await ctx.answerCbQuery?.('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    return;
  }

  updateSession(userId, { state: SessionState.AWAITING_PRESET_NAME });

  await safeEditMessage(
    ctx,
    '💾 *SAVE CUSTOM PRESET*\n\n' +
    'Please send a name for this preset in the chat (e.g. `My Podcast Glow` or `Viral TikTok`):\n\n' +
    'Send /cancel to abort.'
  );
}

/**
 * Handles saving preset from user text input.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} presetName
 */
export async function handleStudioPresetNameInput(ctx, presetName) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session || !session.data?.captionConfig) {
    deleteSession(userId);
    await ctx.reply('⚠️ Session data lost. Send /clip to start fresh.');
    return;
  }

  const cleanName = presetName.trim().slice(0, 32);
  if (!cleanName) {
    await ctx.reply('⚠️ Please provide a non-empty name for your preset.');
    return;
  }

  try {
    await saveUserCaptionPreset({
      telegramUserId: userId,
      presetName: cleanName,
      config: session.data.captionConfig,
    });

    updateSession(userId, { state: SessionState.CAPTION_STUDIO });

    await ctx.reply(
      `✅ Preset *"${cleanName}"* saved successfully!\n\nYou can reload it anytime from *Saved Presets*.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎬 Continue to Confirm', 'studio_confirm')],
          [Markup.button.callback('✨ Back to Studio', 'studio_cust_hub')],
        ]),
      }
    );
  } catch (err) {
    logger.error(`Failed to save preset for user ${userId}:`, err);
    await ctx.reply('❌ Failed to save preset. Please try again.');
  }
}

/**
 * Displays the list of saved presets for the user.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderStudioPresetList(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const presets = await getUserCaptionPresets(userId);

  if (presets.length === 0) {
    const text =
      '📂 *MY SAVED PRESETS*\n\n' +
      'You have not saved any custom presets yet.\n\n' +
      'Customize any caption style and click *💾 Save Preset* to save your unique looks!';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✨ Open Studio', 'studio_cust_hub')],
      [Markup.button.callback('🎨 Gallery', 'studio_gallery_0')],
    ]);

    await safeEditMessage(ctx, text, keyboard);
    return;
  }

  const text =
    `📂 *MY SAVED PRESETS* (${presets.length}/10)\n\n` +
    'Select a preset to load into the studio:';

  const rows = presets.map((p) => [
    Markup.button.callback(`✨ ${p.preset_name}`, `studio_preset_load_${p.id}`),
    Markup.button.callback('🗑', `studio_preset_del_${p.id}`),
  ]);

  rows.push([
    Markup.button.callback('✨ Back to Studio', 'studio_cust_hub'),
    Markup.button.callback('🎨 Gallery', 'studio_gallery_0'),
  ]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(rows));
}

/**
 * Loads a saved preset into the active session.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} presetId
 */
export async function handleStudioPresetLoad(ctx, presetId) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const presets = await getUserCaptionPresets(userId);
  const target = presets.find((p) => String(p.id) === String(presetId) || p.preset_name === String(presetId));

  if (!target) {
    try {
      await ctx.answerCbQuery('⚠️ Preset not found.', { show_alert: true });
    } catch {}
    return renderStudioPresetList(ctx);
  }

  const loadedConfig = sanitizeStudioConfig(target.config);

  updateSession(userId, {
    state: SessionState.CAPTION_STUDIO,
    data: {
      captionConfig: loadedConfig,
    },
  });

  try {
    await ctx.answerCbQuery(`✓ Loaded preset "${target.preset_name}"!`);
  } catch {}

  await renderStudioHome(ctx, loadedConfig);
}

/**
 * Deletes a user preset.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} presetId
 */
export async function handleStudioPresetDelete(ctx, presetId) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const presets = await getUserCaptionPresets(userId);
  const target = presets.find((p) => String(p.id) === String(presetId) || p.preset_name === String(presetId));

  if (target) {
    await deleteUserCaptionPreset(userId, target.preset_name);
    try {
      await ctx.answerCbQuery(`🗑 Deleted "${target.preset_name}"`);
    } catch {}
  }

  await renderStudioPresetList(ctx);
}
