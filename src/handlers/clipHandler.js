import { Markup } from 'telegraf';
import {
  SessionState,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  checkAndConsumeExpiredNotice,
  clearExpiredNotice,
} from '../session/sessionStore.js';
import {
  isValidYouTubeUrl,
  isValidTimestamp,
  parseTimestampToSeconds,
  validateTimestampRange,
} from '../utils/validator.js';
import { parseBatchRanges } from '../utils/batchParser.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { isUserBusy } from '../jobs/jobRunner.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { touchUser, recordUserRequest } from '../db/userRepository.js';
import { isAccessEnabled, getRemainingDailyQuota } from '../services/authService.js';
import { isAdminSearching, handleSearchInput } from './adminHandler.js';

/**
 * Handles the /clip command to start a new clipping session.
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleClipCommand(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Touch user record and sync profile
  await touchUser({
    telegramUserId: userId,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    lastName: ctx.from?.last_name,
  });

  // Access check: block disabled users
  const allowed = await isAccessEnabled(userId);
  if (!allowed) {
    await ctx.reply('🚫 Your access to the bot has been disabled by an administrator.');
    return;
  }

  // Quota check: inform users who reached their daily limit
  const quota = await getRemainingDailyQuota(userId);
  if (!quota.isUnlimited && quota.remaining <= 0) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      [Markup.button.callback('👤 My Account', 'start_my_account')],
    ]);
    await ctx.reply(
      `⚠️ *Daily Limit Reached*\n\n` +
      `You have reached your daily limit of *${quota.limit} clips* today (${quota.usage}/${quota.limit}).\n\n` +
      `Upgrade to PRO for 100 clips/day and exclusive features like Square Focus.`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    return;
  }

  await recordUserRequest(userId);

  // Reject if user already has the maximum active clips being processed
  if (isUserBusy(userId)) {
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  // Initialize or reset session to awaiting_url
  createSession(userId, SessionState.AWAITING_URL);
  logger.info(`User ${userId} started /clip session`);

  await ctx.reply('🎬 Send the YouTube video URL you want to clip:');
}

/**
 * Handles the /cancel command to abort an ongoing session.
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleCancelCommand(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = getSession(userId);
  if (!session || session.state === SessionState.IDLE) {
    await ctx.reply('There is no active clipping session to cancel.\nSend /clip to start a new one!');
    return;
  }

  deleteSession(userId);
  logger.info(`User ${userId} cancelled active clipping session`);

  await ctx.reply('❌ Clipping request cancelled. Your session has been cleared.\nSend /clip whenever you\'re ready to try again.');
}

/**
 * Handles incoming text messages and routes them according to the user's session state.
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleTextMessage(ctx) {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();

  if (!userId || !text) return;

  // Touch user record
  await touchUser({
    telegramUserId: userId,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    lastName: ctx.from?.last_name,
  });

  // Check if this input belongs to an active admin user search
  if (isAdminSearching(userId)) {
    const handled = await handleSearchInput(ctx);
    if (handled) return;
  }

  // If the message is a command (starts with /), let telegraf command handlers take care of it
  if (text.startsWith('/')) {
    return;
  }

  // Access check: block disabled users from continuing interactive conversation
  const allowed = await isAccessEnabled(userId);
  if (!allowed) {
    await ctx.reply('🚫 Your access to the bot has been disabled by an administrator.');
    return;
  }

  const session = getSession(userId);

  // If no active session or idle, check if the session just expired due to inactivity
  if (!session || session.state === SessionState.IDLE) {
    const expired = checkAndConsumeExpiredNotice(userId);
    if (expired) {
      const expiredKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✂️ Create Clip', 'start_create_clip')],
        [
          Markup.button.callback('👤 My Account', 'start_my_account'),
          Markup.button.callback('📜 My Clips', 'start_my_history'),
        ],
        [Markup.button.callback('📚 Recent Videos', 'recent_page_1')],
      ]);

      await ctx.reply(
        '⏱️ *Your previous session expired after 1 hour of inactivity.*\n\n' +
        'Let\'s start fresh:',
        { parse_mode: 'Markdown', ...expiredKeyboard }
      );
      return;
    }

    await ctx.reply(
      '💡 You do not have an active clipping session.\n' +
      'Send /clip to start creating a new vertical video clip!'
    );
    return;
  }

  switch (session.state) {
    case SessionState.AWAITING_URL:
      await handleUrlInput(ctx, userId, text);
      break;

    case SessionState.AWAITING_START:
      await handleStartTimestampInput(ctx, userId, text);
      break;

    case SessionState.AWAITING_END:
      await handleEndTimestampInput(ctx, userId, text, session);
      break;

    case SessionState.AWAITING_RATIO:
      await ctx.reply(
        'Choose Aspect Ratio:',
        Markup.inlineKeyboard([
          [Markup.button.callback('9:16 Vertical', 'ratio_vertical')],
          [Markup.button.callback('1:1 Square', 'ratio_square')],
          [Markup.button.callback('16:9 Landscape', 'ratio_horizontal')],
        ])
      );
      break;

    case SessionState.AWAITING_PRESENTATION:
      await ctx.reply(
        'Choose Presentation:',
        Markup.inlineKeyboard([
          [Markup.button.callback('Standard', 'presentation_standard')],
          [Markup.button.callback('Square Focus ⭐ PRO', 'presentation_square_focus')],
        ])
      );
      break;

    case SessionState.AWAITING_CAPTIONS:
      await ctx.reply(
        'Captions:',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ On', 'caption_yes'),
            Markup.button.callback('❌ Off', 'caption_no'),
          ],
        ])
      );
      break;

    case SessionState.AWAITING_STYLE:
      await ctx.reply(
        '🎨 Please select one of the caption styles using the buttons above to proceed, or send /cancel to abort.'
      );
      break;

    case SessionState.AWAITING_BATCH_RANGES:
      await handleBatchRangesInput(ctx, userId, text, session);
      break;

    case SessionState.AWAITING_BATCH_CONFIRMATION:
      await ctx.reply(
        '⚠️ Please confirm using the buttons below:',
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Export', 'batch_confirm_export')],
          [Markup.button.callback('❌ Cancel', 'batch_cancel')],
        ])
      );
      break;

    default:
      logger.warn(`User ${userId} encountered unhandled session state: ${session.state}`);
      deleteSession(userId);
      await ctx.reply('Something went wrong with the session. Please send /clip to start fresh.');
      break;
  }
}

/**
 * Step 1: Validate and save YouTube URL, then prompt for start timestamp.
 */
async function handleUrlInput(ctx, userId, text) {
  if (!isValidYouTubeUrl(text)) {
    await ctx.reply(
      '❌ Invalid YouTube URL.\n\n' +
      'Please send a valid YouTube link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...):\n\n' +
      'Or send /cancel to stop.'
    );
    return;
  }

  updateSession(userId, {
    state: SessionState.AWAITING_START,
    data: { url: text },
  });

  logger.info(`User ${userId} submitted valid YouTube URL`);

  await ctx.reply('⏱️ Enter start timestamp (e.g. 01:15 or 1:15)');
}

/**
 * Step 2: Validate and save start timestamp, then prompt for end timestamp.
 */
async function handleStartTimestampInput(ctx, userId, text) {
  if (!isValidTimestamp(text)) {
    await ctx.reply(
      '❌ Invalid start timestamp format.\n\n' +
      'Please use MM:SS (e.g., `01:30`) or HH:MM:SS (e.g., `01:15:00`).\n' +
      'Try again or send /cancel to abort.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const startSeconds = parseTimestampToSeconds(text);
  updateSession(userId, {
    state: SessionState.AWAITING_END,
    data: { startTime: text, startSeconds },
  });

  logger.info(`User ${userId} submitted start timestamp: ${text} (${startSeconds}s)`);

  await ctx.reply('⏱️ Enter end timestamp (e.g. 02:00 or 2:00)');
}

/**
 * Step 3: Validate and save end timestamp, then prompt for video ratio format.
 */
async function handleEndTimestampInput(ctx, userId, text, session) {
  const startTime = session.data?.startTime;
  const validation = validateTimestampRange(startTime, text);

  if (!validation.valid) {
    await ctx.reply(
      `❌ ${validation.error}\n\n` +
      `Start timestamp was: \`${startTime}\`\n` +
      'Please provide an end timestamp greater than the start, or send /cancel to abort.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  updateSession(userId, {
    state: SessionState.AWAITING_RATIO,
    data: {
      endTime: text,
      startSeconds: validation.startSeconds,
      endSeconds: validation.endSeconds,
      duration: validation.duration,
    },
  });

  logger.info(`User ${userId} submitted end timestamp: ${text} (${validation.endSeconds}s, duration: ${validation.duration}s)`);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('9:16 Vertical', 'ratio_vertical')],
    [Markup.button.callback('1:1 Square', 'ratio_square')],
    [Markup.button.callback('16:9 Landscape', 'ratio_horizontal')],
  ]);

  await ctx.reply('Choose Aspect Ratio:', keyboard);
}

/**
 * Handles multi-line batch range input, validates every range, and shows confirmation.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} userId
 * @param {string} text
 * @param {object} session
 */
async function handleBatchRangesInput(ctx, userId, text, session) {
  const result = parseBatchRanges(text);
  if (!result.valid) {
    await ctx.reply(
      `❌ *Invalid clip ranges:*\n\n${result.error}\n\n` +
      `💡 *Example format (one range per line):*\n` +
      `\`00:10-00:30\`\n` +
      `\`01:15-01:45\`\n` +
      `\`03:20-04:00\`\n\n` +
      `Please re-enter your ranges or send /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const ranges = result.ranges;

  // Validate that user has enough daily quota slots remaining
  const quota = await getRemainingDailyQuota(userId);
  if (!quota.isUnlimited && quota.remaining < ranges.length) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      [Markup.button.callback('👤 My Account', 'start_my_account')],
    ]);
    await ctx.reply(
      `⚠️ *Daily Limit Reached*\n\n` +
      `This batch requires *${ranges.length}* clips, but you only have *${quota.remaining}/${quota.limit}* clips remaining today.\n\n` +
      `Upgrade to PRO for 100 clips/day and exclusive features like Square Focus.`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    return;
  }

  updateSession(userId, {
    state: SessionState.AWAITING_BATCH_CONFIRMATION,
    data: {
      batchRanges: ranges,
    },
  });

  const rangeList = ranges
    .map((r, i) => `${i + 1}. \`${r.start}\` → \`${r.end}\` (${r.duration}s)`)
    .join('\n');

  const confirmMsg =
    `📦 *${ranges.length} clips ready for export*\n\n` +
    `${rangeList}\n\n` +
    `• *Format:* 📱 Vertical 9:16\n` +
    `• *Captions:* NO\n\n` +
    `Click *Export* to begin batch clipping:`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Export', 'batch_confirm_export'),
      Markup.button.callback('❌ Cancel', 'batch_cancel'),
    ],
  ]);

  await ctx.reply(confirmMsg, { parse_mode: 'Markdown', ...keyboard });
}

