import { Telegraf } from 'telegraf';
import { handleStart, handleHelp } from '../handlers/startHandler.js';
import {
  handleClipCommand,
  handleCancelCommand,
  handleTextMessage,
} from '../handlers/clipHandler.js';
import {
  handleRatioCallback,
  handlePresentationCallback,
  handleCaptionCallback,
  handleStyleCallback,
  handleReclipSingleCallback,
  handleReclipBatchCallback,
  handleBatchConfirmExportCallback,
  handleBatchCancelCallback,
} from '../handlers/callbackHandler.js';
import {
  handleMyPlan,
  handleProCommand,
  handleUnproCommand,
  handleUpgradeProInfo,
  renderProUpgradeScreen,
  renderProSubscriptionModal,
  handleNotifyMeCallback,
  handleManualContactOwnerInfo,
} from '../handlers/planHandler.js';
import {
  handleAccountCommand,
  handleMyClipHistory,
} from '../handlers/accountHandler.js';
import {
  renderClipHistory,
  handleHistoryCommand,
  handleHistoryPageCallback,
  handleClipDetailCallback,
  handleHistoryReclipCallback,
  handleRecentVideosCommand,
  handleRecentPageCallback,
  handleRecentDetailCallback,
  handleRecentReclipCallback,
  handleRecentClipsListCallback,
} from '../handlers/historyHandler.js';
import {
  handleAdminCommand,
  handleAdminAction,
  handleAdminDocument,
} from '../handlers/adminHandler.js';
import {
  handleStudioEntry,
  handleStudioStandardFallback,
  renderStudioHome,
  renderStudioGallery,
  renderStudioPreview,
  renderStudioCustomizeHub,
  renderCustomizeTypography,
  renderCustomizeFontPairs,
  renderCustomizePrimaryFont,
  renderCustomizeEmphasisFont,
  renderCustomizeTransitions,
  renderCustomizeColors,
  renderCustomizeAnimation,
  renderStudioAnimationPreview,
  renderCustomizePosition,
  renderCustomizeEffects,
  renderCustomizeEmphasis,
  handleStudioSetAction,
  renderStudioConfirm,
  handleStudioApply,
  handleStudioPresetSavePrompt,
  renderStudioPresetList,
  handleStudioPresetLoad,
  handleStudioPresetDelete,
} from '../handlers/captionStudioHandler.js';
import { createDefaultStudioConfig } from '../services/captions/captionStudio.js';
import { updateSession, getSession, refreshSessionInteraction, startSessionCleanup } from '../session/sessionStore.js';
import { touchUser } from '../db/userRepository.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Initializes and configures the Telegraf bot instance.
 *
 * @param {string} token Telegram Bot Token
 * @returns {Telegraf} Configured Telegraf instance
 */
export function createBot(token) {
  // Start background periodic session cleanup (every 5 mins)
  startSessionCleanup();

  const bot = new Telegraf(token, {
    telegram: {
      apiRoot: config.telegramApiBaseUrl,
    },
  });


  // Global error handler
  bot.catch((err, ctx) => {
    logger.error(
      `[CRITICAL_UNCAUGHT] Error encountered for update ${ctx.update?.update_id} (chat: ${ctx.chat?.id}):\n` +
      `  Build:   ${TELEGRAM_CLIPPER_BUILD} (PID: ${process.pid})\n` +
      `  Message: ${err?.message}\n` +
      `  Stack:   ${err?.stack}`
    );

    // Attempt to notify user with exact error in debug mode
    if (ctx.chat?.id) {
      const debugMsg =
        `⚠️ *Pipeline Error [Build: ${TELEGRAM_CLIPPER_BUILD} | PID: ${process.pid}]*\n\n` +
        `*Error:* \`${err?.message || 'Unknown error'}\`\n\n` +
        `*Stack:*\n\`\`\`\n${(err?.stack || '').slice(0, 800)}\n\`\`\`\n\n` +
        `Send /clip to try again.`;

      ctx.replyWithMarkdown(debugMsg).catch((replyErr) => {
        logger.error('Failed to send markdown error message to user, trying plain text:', replyErr.message);
        ctx.reply(`⚠️ Pipeline Error [${TELEGRAM_CLIPPER_BUILD} | PID: ${process.pid}]:\n${err?.message || 'Unknown error'}\n\nSend /clip to try again.`).catch(() => {});
      });
    }
  });

  // Global profile synchronization & session activity refresh middleware:
  // On every incoming Telegram update from a user, upsert/update the users row using latest ctx.from
  // and refresh the user's active session inactivity TTL.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id) {
      try {
        await touchUser({
          telegramUserId: ctx.from.id,
          username: ctx.from.username ?? null,
          firstName: ctx.from.first_name ?? null,
          lastName: ctx.from.last_name ?? null,
        });
      } catch (syncErr) {
        logger.warn(`[USER_SYNC] Failed to synchronize profile for user ${ctx.from.id}:`, syncErr.message);
      }

      // Refresh session inactivity TTL on any interaction (message, command, callback)
      try {
        refreshSessionInteraction(ctx.from.id);
      } catch (sessErr) {
        logger.debug(`[SESSION_REFRESH] Failed to refresh session for user ${ctx.from.id}:`, sessErr.message);
      }
    }
    return next();
  });

  // Command handlers
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('clip', handleClipCommand);
  bot.command('cancel', handleCancelCommand);
  bot.command('account', handleAccountCommand);
  bot.command('history', handleHistoryCommand);
  bot.command('recent', handleRecentVideosCommand);
  bot.command('myplan', handleMyPlan);
  bot.command('pro', handleProCommand);
  bot.command('unpro', handleUnproCommand);
  bot.command('admin', handleAdminCommand);

  // Quick navigation callbacks from /start and /account
  bot.action('start_create_clip', handleClipCommand);
  bot.action('account_create_clip', handleClipCommand);
  bot.action('start_my_account', handleAccountCommand);
  bot.action('start_my_history', (ctx) => renderClipHistory(ctx, 1));
  bot.action('account_clip_history', (ctx) => renderClipHistory(ctx, 1));

  // History & Recent videos callbacks
  bot.action(/^history_page_(\d+)$/, handleHistoryPageCallback);
  bot.action(/^history_clip_(\d+)$/, handleClipDetailCallback);
  bot.action(/^history_reclip_(\d+)$/, handleHistoryReclipCallback);
  bot.action(/^recent_page_(\d+)$/, handleRecentPageCallback);
  bot.action(/^recent_detail_(.+)$/, handleRecentDetailCallback);
  bot.action(/^recent_reclip_(.+)$/, handleRecentReclipCallback);
  bot.action(/^recent_clips_(.+)_\d+$/, handleRecentClipsListCallback);

  // Callback query handlers for inline buttons
  bot.action(/^admin_/, handleAdminAction);
  bot.action(/^ratio_(vertical|horizontal|square)$/, handleRatioCallback);
  bot.action(/^presentation_(standard|square_focus)$/, handlePresentationCallback);
  bot.action('upgrade_pro_screen', renderProUpgradeScreen);
  bot.action('upgrade_pro_checkout', renderProSubscriptionModal);
  bot.action('upgrade_notify_me', handleNotifyMeCallback);
  bot.action('manual_contact_owner_info', handleManualContactOwnerInfo);
  bot.action('upgrade_pro_active_info', async (ctx) => {
    try {
      await ctx.answerCbQuery('⭐ You are on PRO! Enjoy 100 clips/day and Square Focus.', { show_alert: true });
    } catch {}
  });
  bot.action('upgrade_pro_info', handleUpgradeProInfo);
  bot.action('caption_yes', handleCaptionCallback);
  bot.action('caption_no', handleCaptionCallback);
  bot.action('caption_on', handleCaptionCallback);
  bot.action('caption_off', handleCaptionCallback);
  bot.action(/^style_(.+)$/, handleStyleCallback);

  // PRO Caption Studio handlers
  bot.action('studio_standard_fallback', handleStudioStandardFallback);
  bot.action('studio_home', (ctx) => renderStudioHome(ctx));
  bot.action(/^studio_gallery_(\d+)$/, (ctx) => renderStudioGallery(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^studio_select_(.+)$/, async (ctx) => {
    const styleId = ctx.match[1];
    const userId = ctx.from?.id;
    if (userId) {
      const session = getSession(userId);
      if (!session) {
        try {
          await ctx.answerCbQuery('⏱️ This session has expired. Please start again.', { show_alert: true });
        } catch {}
        await ctx.reply('⏱️ This session has expired. Please start again.\n\nSend /clip to start a new request!');
        return;
      }
      const cfg = createDefaultStudioConfig(styleId);
      updateSession(userId, { data: { captionConfig: cfg } });
    }
    return renderStudioConfirm(ctx);
  });
  bot.action('studio_preview', renderStudioPreview);
  bot.action('studio_cust_hub', renderStudioCustomizeHub);
  bot.action('studio_cust_typo', renderCustomizeTypography);
  bot.action('studio_typo_pairs', renderCustomizeFontPairs);
  bot.action('studio_typo_pfont', renderCustomizePrimaryFont);
  bot.action('studio_typo_efont', renderCustomizeEmphasisFont);
  bot.action('studio_cust_trans', renderCustomizeTransitions);
  bot.action('studio_cust_anim', renderCustomizeAnimation);
  bot.action('studio_anim_preview', renderStudioAnimationPreview);
  bot.action('studio_cust_color', renderCustomizeColors);
  bot.action('studio_cust_pos', renderCustomizePosition);
  bot.action('studio_cust_fx', renderCustomizeEffects);
  bot.action('studio_cust_emph', renderCustomizeEmphasis);
  bot.action(/^studio_set_(.+)$/, (ctx) => handleStudioSetAction(ctx, ctx.match[1]));
  bot.action('studio_confirm', renderStudioConfirm);
  bot.action('studio_apply', handleStudioApply);
  bot.action('studio_preset_save_prompt', handleStudioPresetSavePrompt);
  bot.action('studio_preset_list', renderStudioPresetList);
  bot.action(/^studio_preset_load_(.+)$/, (ctx) => handleStudioPresetLoad(ctx, ctx.match[1]));
  bot.action(/^studio_preset_del_(.+)$/, (ctx) => handleStudioPresetDelete(ctx, ctx.match[1]));

  bot.action('reclip_single', handleReclipSingleCallback);
  bot.action('reclip_batch', handleReclipBatchCallback);
  bot.action('batch_confirm_export', handleBatchConfirmExportCallback);
  bot.action('batch_cancel', handleBatchCancelCallback);
  bot.action(/^batch_cancel_/, handleBatchCancelCallback);

  // General text message handler for conversation state transitions
  bot.on('text', handleTextMessage);

  // Document handler for admin cookie uploads
  bot.on('document', handleAdminDocument);

  return bot;
}
