import { Markup } from 'telegraf';
import {
  SessionState,
  getSession,
  updateSession,
  deleteSession,
  getUserLastUrl,
  getUserLastSettings,
} from '../session/sessionStore.js';
import { getVideoFormat } from '../config/formats.js';
import { listCaptionStyles } from '../services/captions/captionEngine.js';
import { isUserBusy, submitClipJob } from '../jobs/jobRunner.js';
import { createAndStartBatch, cancelBatch } from '../jobs/batchRunner.js';
import { canUseFeature, FEATURE_SQUARE_FOCUS } from '../services/authService.js';
import { handleStudioEntry, handleStudioStandardFallback } from './captionStudioHandler.js';
import { createDefaultStudioConfig, getStudioStyle } from '../services/captions/captionStudio.js';
import { saveUserLastCaptionConfig } from '../db/captionPresetRepository.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Handles inline keyboard selection for video ratio format (callbackData: 'ratio_<formatId>').
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRatioCallback(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId) return;

  // Prevent duplicate execution if user already has maximum active processing jobs
  if (isUserBusy(userId)) {
    try {
      await ctx.answerCbQuery();
    } catch {}
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const session = getSession(userId);

  if (!session || session.state !== SessionState.AWAITING_RATIO) {
    try {
      await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply(
      '⏱️ This session has expired. Please start again.\n\n' +
      'Send /clip to start a new request!'
    );
    return;
  }

  // Acknowledge callback query immediately for valid session
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge ratio callback query:', err.message);
  }

  const selectedRatio = callbackData.replace('ratio_', '').trim();
  const format = getVideoFormat(selectedRatio);

  updateSession(userId, {
    state: SessionState.AWAITING_PRESENTATION,
    data: { ratio: format.id },
  });

  logger.info(`[User ${userId}] Selected video ratio: ${format.id} (${format.label}). Prompting presentation style.`);

  const presentationKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Standard', 'presentation_standard')],
    [Markup.button.callback('Square Focus ⭐ PRO', 'presentation_square_focus')],
  ]);

  const promptText = 'Choose Presentation:';

  try {
    await ctx.editMessageText(promptText, {
      parse_mode: 'Markdown',
      ...presentationKeyboard,
    });
  } catch {
    await ctx.reply(promptText, {
      parse_mode: 'Markdown',
      ...presentationKeyboard,
    });
  }
}

/**
 * Handles inline keyboard selection for presentation style ('presentation_standard' and 'presentation_square_focus').
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handlePresentationCallback(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId) return;

  if (isUserBusy(userId)) {
    try {
      await ctx.answerCbQuery();
    } catch {}
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const session = getSession(userId);

  if (!session || session.state !== SessionState.AWAITING_PRESENTATION) {
    try {
      await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply(
      '⏱️ This session has expired. Please start again.\n\n' +
      'Send /clip to start a new request!'
    );
    return;
  }

  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge presentation callback query:', err.message);
  }

  // Paywall check for Square Focus
  if (callbackData === 'presentation_square_focus') {
    const hasAccess = await canUseFeature(userId, FEATURE_SQUARE_FOCUS);
    if (!hasAccess) {
      logger.info(`[PAYWALL_BLOCKED] User ${userId} attempted to select Square Focus without PRO plan`);

      const paywallKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
        [Markup.button.callback('Standard', 'presentation_standard')],
      ]);

      const paywallMsg =
        '🔒 *Square Focus is a PRO feature*\n\n' +
        'Create premium vertical clips with:\n' +
        '• Full-width 1:1 foreground\n' +
        '• Blurred cinematic background\n' +
        '• Kinetic typography\n' +
        '• Maximum-quality export\n\n' +
        'Upgrade to PRO to unlock Square Focus and 100 clips/day.';

      try {
        await ctx.editMessageText(paywallMsg, {
          parse_mode: 'Markdown',
          ...paywallKeyboard,
        });
      } catch {
        await ctx.reply(paywallMsg, {
          parse_mode: 'Markdown',
          ...paywallKeyboard,
        });
      }
      return;
    }
  }

  const presentation = callbackData === 'presentation_square_focus' ? 'square_focus' : 'standard';

  updateSession(userId, {
    state: SessionState.AWAITING_CAPTIONS,
    data: { presentation },
  });

  logger.info(
    `\n[PRESENTATION]\n` +
    `style=${presentation.toUpperCase()}\n` +
    `user=${userId}`
  );

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ On', 'caption_yes'),
      Markup.button.callback('❌ Off', 'caption_no'),
    ],
  ]);

  const promptText = 'Captions:';

  try {
    await ctx.editMessageText(promptText, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  } catch {
    await ctx.reply(promptText, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }
}

/**
 * Handles inline keyboard callback queries for caption selection ('caption_yes' and 'caption_no').
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleCaptionCallback(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId) return;

  // Prevent duplicate execution if user already has maximum active processing jobs
  if (isUserBusy(userId)) {
    try {
      await ctx.answerCbQuery();
    } catch {}
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const session = getSession(userId);

  if (!session || session.state !== SessionState.AWAITING_CAPTIONS) {
    try {
      await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply(
      '⏱️ This session has expired. Please start again.\n\n' +
      'Send /clip to start a new request!'
    );
    return;
  }

  // Always acknowledge callback query immediately for valid session
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge callback query:', err.message);
  }

  // User chose YES: Present PRO Caption Studio (with PRO gating)
  if (callbackData === 'caption_yes' || callbackData === 'caption_on') {
    updateSession(userId, {
      data: { captions: true },
    });
    await handleStudioEntry(ctx);
    return;
  }

  // User chose NO: Process video directly without captions
  const { url, startTime, endTime, ratio, presentation } = session.data;
  const selectedRatio = ratio || 'vertical';
  const selectedPresentation = presentation || 'standard';
  deleteSession(userId);

  logger.info(
    `[User ${userId}] [DISPATCH_JOB] Dispatching NO captions job for ${url} [${startTime}-${endTime}] [format: ${selectedRatio}] [presentation: ${selectedPresentation}]`
  );

  const ratioLabels = {
    vertical: '9:16',
    square: '1:1',
    horizontal: '16:9',
  };
  const displayRatio = ratioLabels[selectedRatio] || selectedRatio;
  const displayPresentation = selectedPresentation === 'square_focus' ? 'Square Focus' : 'Standard';

  const queuedText =
    '🎬 *Clip Queued!*\n\n' +
    `• *Ratio:* ${displayRatio}\n` +
    `• *Presentation:* ${displayPresentation}\n` +
    `• *Captions:* Off\n` +
    `• *Position:* #1 in queue`;

  let statusMessage;
  try {
    statusMessage = await ctx.editMessageText(queuedText, { parse_mode: 'Markdown' });
  } catch (err) {
    try {
      statusMessage = await ctx.reply(queuedText, { parse_mode: 'Markdown' });
    } catch {}
  }

  const statusMessageId = statusMessage?.message_id || ctx.callbackQuery?.message?.message_id;

  // Submit background job and RETURN IMMEDIATELY (does not hold Telegram callback)
  try {
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
        captions: false,
        captionStyle: null,
        statusMessageId,
      },
    });
  } catch (err) {
    if (err.code === 'FEATURE_LOCKED') {
      const paywallKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      ]);
      await ctx.reply(
        '🔒 *Square Focus is a PRO feature*\n\n' +
        'Upgrade to PRO to unlock Square Focus and 100 clips/day.',
        { parse_mode: 'Markdown', ...paywallKeyboard }
      );
      return;
    }
    throw err;
  }
}

/**
 * Handles inline keyboard selection for caption presets (callbackData: 'style_<styleId>').
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleStyleCallback(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId) return;

  // Prevent duplicate execution if user already has maximum active processing jobs
  if (isUserBusy(userId)) {
    try {
      await ctx.answerCbQuery();
    } catch {}
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const session = getSession(userId);

  if (!session || (session.state !== SessionState.AWAITING_STYLE && session.state !== SessionState.CAPTION_STUDIO)) {
    try {
      await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply(
      '⏱️ This session has expired. Please start again.\n\n' +
      'Send /clip to start a new request!'
    );
    return;
  }

  // Always acknowledge callback query immediately for valid session
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge style callback query:', err.message);
  }

  const styleId = callbackData.replace('style_', '').trim();
  const { url, startTime, endTime, ratio, presentation, captionConfig } = session.data;
  const selectedRatio = ratio || 'vertical';
  const selectedPresentation = presentation || 'standard';

  // Map to full CaptionStudioConfig
  const finalConfig = captionConfig || createDefaultStudioConfig(styleId);
  try {
    await saveUserLastCaptionConfig(userId, finalConfig);
  } catch {}

  // Clear session so user cannot re-trigger while processing
  deleteSession(userId);

  const matchedStyle = getStudioStyle(styleId);
  const displayCaptions = matchedStyle?.name || styleId;

  logger.info(
    `[User ${userId}] [DISPATCH_JOB] Dispatching YES captions (${displayCaptions}) job for ${url} [${startTime}-${endTime}] [format: ${selectedRatio}] [presentation: ${selectedPresentation}]`
  );

  const ratioLabels = {
    vertical: '9:16',
    square: '1:1',
    horizontal: '16:9',
  };
  const displayRatio = ratioLabels[selectedRatio] || selectedRatio;
  const displayPresentation = selectedPresentation === 'square_focus' ? 'Square Focus' : 'Standard';

  const queuedText =
    '🎬 *Clip Queued!*\n\n' +
    `• *Ratio:* ${displayRatio}\n` +
    `• *Presentation:* ${displayPresentation}\n` +
    `• *Captions:* ${displayCaptions}\n` +
    `• *Position:* #1 in queue`;

  let statusMessage;
  try {
    statusMessage = await ctx.editMessageText(queuedText, { parse_mode: 'Markdown' });
  } catch (err) {
    try {
      statusMessage = await ctx.reply(queuedText, { parse_mode: 'Markdown' });
    } catch {}
  }

  const statusMessageId = statusMessage?.message_id || ctx.callbackQuery?.message?.message_id;

  // Submit background job and RETURN IMMEDIATELY (does not hold Telegram callback)
  try {
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
        captionStyle: styleId,
        captionConfig: finalConfig,
        statusMessageId,
      },
    });
  } catch (err) {
    if (err.code === 'FEATURE_LOCKED') {
      const paywallKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      ]);
      await ctx.reply(
        '🔒 *Square Focus is a PRO feature*\n\n' +
        'Upgrade to PRO to unlock Square Focus and 100 clips/day.',
        { parse_mode: 'Markdown', ...paywallKeyboard }
      );
      return;
    }
    throw err;
  }
}

/**
 * Handles the 'reclip_single' callback: Re-uses the previous YouTube URL
 * for this user and prompts immediately for the start timestamp.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleReclipSingleCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge reclip_single callback query:', err.message);
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  const lastUrl = getUserLastUrl(userId);
  if (!lastUrl) {
    await ctx.reply(
      '⚠️ No previous YouTube video found in your recent history.\n' +
      'Send /clip to start a new clipping request!'
    );
    return;
  }

  if (isUserBusy(userId)) {
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const lastSettings = getUserLastSettings(userId);

  updateSession(userId, {
    state: SessionState.AWAITING_START,
    data: {
      url: lastUrl,
      ratio: lastSettings?.ratio || 'vertical',
      captions: lastSettings?.captions || false,
      captionStyle: lastSettings?.captionStyle || null,
    },
  });

  logger.info(`[User ${userId}] Started re-clip with previous URL: ${lastUrl}`);

  await ctx.reply(
    `🎬 *Re-clipping from previous video:*\n` +
    `🔗 \`${lastUrl}\`\n\n` +
    `Step 2 of 5:\n` +
    `Please send the *START* timestamp for the clip.\n\n` +
    `Format: MM:SS or HH:MM:SS\n` +
    `💡 Examples: \`01:15\` or \`01:05:30\`\n\n` +
    `Type /cancel anytime to abort.`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles the 'reclip_batch' callback: Re-uses the previous YouTube URL
 * and prompts the user to enter multi-line timestamp ranges.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleReclipBatchCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge reclip_batch callback query:', err.message);
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  const lastUrl = getUserLastUrl(userId);
  if (!lastUrl) {
    await ctx.reply(
      '⚠️ No previous YouTube video found in your recent history.\n' +
      'Send /clip to start a new clipping request!'
    );
    return;
  }

  if (isUserBusy(userId)) {
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  updateSession(userId, {
    state: SessionState.AWAITING_BATCH_RANGES,
    data: { url: lastUrl },
  });

  logger.info(`[User ${userId}] Prompted for batch ranges for URL: ${lastUrl}`);

  await ctx.reply(
    `📦 *Export Multiple Clips:*\n` +
    `🔗 \`${lastUrl}\`\n\n` +
    `Send multiple clip ranges, one per line (up to 5 clips):\n\n` +
    `💡 *Examples:*\n` +
    `\`00:10-00:30\`\n` +
    `\`01:15-01:45\`\n` +
    `\`03:20-04:00\`\n\n` +
    `Or raw seconds:\n` +
    `\`10-30\`\n` +
    `\`75-105\`\n\n` +
    `Type /cancel anytime to abort.`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles 'batch_confirm_export': Dispatches all parsed batch clips.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleBatchConfirmExportCallback(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  const session = getSession(userId);
  if (!session || session.state !== SessionState.AWAITING_BATCH_CONFIRMATION) {
    try {
      await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
    } catch {}
    await ctx.reply(
      '⏱️ This session has expired. Please start again.\n\n' +
      'Send /clip to start a new request!'
    );
    return;
  }

  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge batch_confirm_export callback query:', err.message);
  }

  const { url, batchRanges } = session.data || {};
  deleteSession(userId);

  if (!url || !batchRanges || !batchRanges.length) {
    await ctx.reply('⚠️ No batch ranges found. Send /clip to start fresh.');
    return;
  }

  logger.info(`[User ${userId}] Starting batch export of ${batchRanges.length} clips for ${url}`);

  try {
    await createAndStartBatch({
      telegram: ctx.telegram,
      chatId,
      userId,
      url,
      ranges: batchRanges,
      ratio: 'vertical',
      captions: false,
      captionStyle: null,
    });
  } catch (err) {
    logger.error(`[User ${userId}] Failed to start batch export:`, err);
    await ctx.reply(`❌ Failed to start batch export: ${err.message}`);
  }
}

/**
 * Handles 'batch_cancel' (during setup) or 'batch_cancel_<batchId>' (live batch).
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleBatchCancelCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to acknowledge batch_cancel callback query:', err.message);
  }

  const userId = ctx.from?.id;
  const callbackData = ctx.callbackQuery?.data;
  if (!userId) return;

  if (callbackData && callbackData.startsWith('batch_cancel_')) {
    const batchId = callbackData.replace('batch_cancel_', '').trim();
    logger.info(`[User ${userId}] User requested cancellation of active batch: ${batchId}`);
    const cancelled = await cancelBatch(batchId);
    if (cancelled) {
      await ctx.reply(
        `🛑 *Batch Cancelled*\nQueued clips for this batch will not be processed.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('⚠️ Batch already completed or not found.');
    }
    return;
  }

  // Setup cancellation
  deleteSession(userId);
  logger.info(`[User ${userId}] Cancelled batch setup session`);
  await ctx.reply(
    '❌ Batch export cancelled. Your session has been cleared.\n' +
    'Send /clip whenever you\'re ready to try again.'
  );
}

