/**
 * Clip History & Recent Videos Handler
 *
 * Provides paginated clip history, detailed clip views,
 * recent video grouping, and seamless same-URL re-clipping.
 */

import crypto from 'node:crypto';
import { Markup } from 'telegraf';
import {
  getUserClipRequests,
  getUserClipRequestCount,
  getClipRequestById,
  getRecentVideos,
  getRecentVideoCount,
  getRecentClipsForVideo,
  getUserClipCountForVideo,
} from '../db/clipRequestRepository.js';
import { touchUser } from '../db/userRepository.js';
import {
  isAccessEnabled,
  getRemainingDailyQuota,
} from '../services/authService.js';
import {
  createSession,
  SessionState,
  setUserLastUrl,
} from '../session/sessionStore.js';
import { isUserBusy } from '../jobs/jobRunner.js';
import {
  extractYouTubeVideoId,
  canonicalizeYouTubeUrl,
} from '../utils/validator.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = 5;

// Cache mapping for short URL hashes to canonical URLs (when video ID is unavailable)
const urlHashCache = new Map();

function getUrlKey(canonicalUrl, videoId) {
  if (videoId) return `v_${videoId}`;
  const hash = crypto.createHash('md5').update(canonicalUrl || '').digest('hex').slice(0, 16);
  urlHashCache.set(hash, canonicalUrl);
  return `h_${hash}`;
}

function resolveUrlFromKey(key) {
  if (key.startsWith('v_')) {
    const videoId = key.slice(2);
    return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
  }
  if (key.startsWith('h_')) {
    const hash = key.slice(2);
    const canonicalUrl = urlHashCache.get(hash);
    return { videoId: null, canonicalUrl: canonicalUrl || null };
  }
  return { videoId: key, canonicalUrl: `https://www.youtube.com/watch?v=${key}` };
}

/**
 * Formats seconds into MM:SS or HH:MM:SS.
 *
 * @param {number|string} sec
 * @returns {string}
 */
export function formatSeconds(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Formats a Date into 'Today, 3:41 PM' / 'Yesterday, 8:31 PM' / '14 Sep 2026, 3:41 PM'.
 *
 * @param {Date|string} date
 * @returns {string}
 */
export function formatRelativeTime(date) {
  if (!date) return 'Unknown';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Unknown';

  const now = new Date();
  const timeStr = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const todayStr = now.toDateString();
  const targetStr = d.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  if (targetStr === todayStr) {
    return `Today, ${timeStr}`;
  }
  if (targetStr === yesterdayStr) {
    return `Yesterday, ${timeStr}`;
  }

  const datePart = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${datePart}, ${timeStr}`;
}

/**
 * Formats a Date into '14 Sep 2026 · 3:41 PM'.
 *
 * @param {Date|string} date
 * @returns {string}
 */
export function formatRequestedDate(date) {
  if (!date) return 'Unknown';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Unknown';

  const datePart = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `${datePart} · ${timePart}`;
}

/**
 * Returns clean human status string with icon.
 *
 * @param {string} status
 * @returns {string}
 */
export function formatClipStatus(status) {
  switch (status) {
    case 'COMPLETED':
      return '✅ Completed';
    case 'FAILED':
      return '❌ Failed';
    case 'CANCELLED':
      return '🚫 Cancelled';
    case 'PROCESSING':
    case 'QUEUED':
    case 'DOWNLOADING':
    case 'UPLOADING':
    case 'REQUESTED':
      return '⏳ Processing';
    default:
      return `⏳ ${status || 'Unknown'}`;
  }
}

/**
 * Returns icon for status.
 *
 * @param {string} status
 * @returns {string}
 */
export function getStatusIcon(status) {
  switch (status) {
    case 'COMPLETED':
      return '✅';
    case 'FAILED':
      return '❌';
    case 'CANCELLED':
      return '🚫';
    default:
      return '⏳';
  }
}

/**
 * Formats presentation style for display.
 *
 * @param {string} style
 * @returns {string}
 */
export function formatStyleName(style) {
  switch (style) {
    case 'square_focus':
      return 'Square Focus';
    case 'podcast_pro':
      return 'Podcast Pro';
    case 'standard':
      return 'Standard';
    default:
      return style ? style.charAt(0).toUpperCase() + style.slice(1) : 'Standard';
  }
}

/**
 * Formats captions label for display.
 *
 * @param {string|boolean} captions
 * @returns {string}
 */
export function formatCaptionsLabel(captions) {
  return captions === 'YES' || captions === true ? 'Captions' : 'No captions';
}

/**
 * Renders user clip history with pagination.
 * Accessible via /history or [ 📜 Clip History ].
 *
 * @param {import('telegraf').Context} ctx
 * @param {number} [page=1]
 */
export async function renderClipHistory(ctx, page = 1) {
  const userId = ctx.from?.id;
  if (!userId) return;

  await touchUser({
    telegramUserId: userId,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    lastName: ctx.from?.last_name,
  });

  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const totalClips = await getUserClipRequestCount(userId);
  const totalPages = Math.ceil(totalClips / PAGE_SIZE) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const clips = await getUserClipRequests(userId, { limit: PAGE_SIZE, offset });

  if (clips.length === 0) {
    const emptyText =
      '📜 *My Clips*\n\n' +
      '_You haven\'t created any clips yet._\n\n' +
      'Send /clip to start your first clip request!';
    const emptyKeyboard = [
      [Markup.button.callback('✂️ Create Clip', 'start_create_clip')],
      [Markup.button.callback('🔙 Account', 'start_my_account')],
    ];

    try {
      await ctx.editMessageText(emptyText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(emptyKeyboard),
      });
    } catch {
      await ctx.reply(emptyText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(emptyKeyboard),
      });
    }
    return;
  }

  let text = `📜 *My Clips* _(Page ${safePage}/${totalPages})_\n\n`;

  const itemButtons = [];

  clips.forEach((clip, index) => {
    const itemNum = index + 1;
    const icon = getStatusIcon(clip.status);
    const startStr = formatSeconds(clip.start_seconds);
    const endStr = formatSeconds(clip.end_seconds);
    const timeStr = formatRelativeTime(clip.requested_at);

    let subtitle = '';
    if (clip.status === 'FAILED') {
      subtitle = 'Processing failed';
    } else if (clip.status === 'CANCELLED') {
      subtitle = 'Cancelled';
    } else {
      const styleName = formatStyleName(clip.presentation_style);
      const capName = formatCaptionsLabel(clip.captions);
      subtitle = `${styleName} · ${capName}`;
    }

    text += `${itemNum}. ${icon} \`${startStr}\` → \`${endStr}\`\n` +
            `   ${subtitle}\n` +
            `   ${timeStr}\n\n`;

    itemButtons.push(Markup.button.callback(`${itemNum}`, `history_clip_${clip.id}`));
  });

  const buttons = [];

  // Clip selection buttons: [ 1 ] [ 2 ] [ 3 ] ...
  buttons.push(itemButtons);

  // Pagination navigation row
  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback('◀ Prev', `history_page_${safePage - 1}`));
  }
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback('Next ▶', `history_page_${safePage + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  // Action buttons
  buttons.push([
    Markup.button.callback('✂️ Create Clip', 'start_create_clip'),
    Markup.button.callback('🔙 Account', 'start_my_account'),
  ]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

/**
 * Handles the /history command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleHistoryCommand(ctx) {
  await renderClipHistory(ctx, 1);
}

/**
 * Handles pagination callback query: history_page_<page>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleHistoryPageCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^history_page_(\d+)$/);
  const page = match ? parseInt(match[1], 10) : 1;
  await renderClipHistory(ctx, page);
}

/**
 * Renders detail view for a specific historical clip.
 * Strictly verifies ownership so user B cannot view user A's clip.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} clipId
 */
export async function renderClipDetail(ctx, clipId) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const clip = await getClipRequestById(clipId, userId);
  if (!clip) {
    try {
      await ctx.answerCbQuery('⚠️ Clip not found or access denied.', { show_alert: true });
    } catch {}
    await ctx.reply('⚠️ Clip not found or you do not have permission to view it.');
    return;
  }

  const statusDisplay = formatClipStatus(clip.status);
  const startStr = formatSeconds(clip.start_seconds);
  const endStr = formatSeconds(clip.end_seconds);
  const durationSec = Math.round(Number(clip.duration) || (Number(clip.end_seconds) - Number(clip.start_seconds)) || 0);
  const formatDisplay = clip.format === 'horizontal' ? '16:9' : clip.format === 'square' ? '1:1' : '9:16';
  const styleDisplay = formatStyleName(clip.presentation_style);
  const captionsDisplay = clip.captions === 'YES' || clip.captions === true ? 'Enabled' : 'Disabled';
  const requestedDisplay = formatRequestedDate(clip.requested_at);

  const cleanUrl = clip.youtube_url || 'N/A';

  const text =
    `🎬 *Clip Details*\n\n` +
    `*Status:* ${statusDisplay}\n\n` +
    `*YouTube:*\n${cleanUrl}\n\n` +
    `*Range:*\n\`${startStr}\` → \`${endStr}\`\n` +
    `*Duration:* ${durationSec} sec\n\n` +
    `*Format:*\n${formatDisplay}\n\n` +
    `*Style:*\n${styleDisplay}\n\n` +
    `*Captions:*\n${captionsDisplay}\n\n` +
    `*Requested:*\n${requestedDisplay}`;

  const buttons = [
    [Markup.button.callback('🔁 Create Another Clip', `history_reclip_${clip.id}`)],
  ];

  if (cleanUrl.startsWith('http')) {
    buttons.push([Markup.button.url('▶️ Open Original', cleanUrl)]);
  }

  buttons.push([Markup.button.callback('🔙 History', 'history_page_1')]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

/**
 * Handles callback query: history_clip_<clipId>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleClipDetailCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^history_clip_(\d+)$/);
  if (!match) return;

  await renderClipDetail(ctx, match[1]);
}

/**
 * Initiates the same-URL reclip workflow for a specific historical clip or recent video.
 * Validates quota and access, then prompts for start timestamp.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} targetUrl
 */
export async function startReclipWithUrl(ctx, targetUrl) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  // Access validation
  const allowed = await isAccessEnabled(userId);
  if (!allowed) {
    await ctx.reply('🚫 Your access to the bot has been disabled by an administrator.');
    return;
  }

  // Quota validation
  const quota = await getRemainingDailyQuota(userId);
  if (!quota.isUnlimited && quota.remaining <= 0) {
    await ctx.reply(
      `⚠️ *Daily Limit Reached*\n\n` +
      `You have reached your daily limit of *${quota.limit} clips* today (${quota.usage}/${quota.limit}).\n\n` +
      `Upgrade to PRO for higher daily limits (100 clips/day) and premium features.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Check busy status
  if (isUserBusy(userId)) {
    await ctx.reply(
      `⚠️ You already have the maximum allowed active clip requests (${config.maxActiveJobsPerUser || 2}) in progress. Please wait for one to finish before starting a new one!`
    );
    return;
  }

  const canonical = canonicalizeYouTubeUrl(targetUrl) || targetUrl;

  createSession(userId, SessionState.AWAITING_START, { url: canonical });
  setUserLastUrl(userId, canonical);

  logger.info(`[User ${userId}] Started same-URL reclip workflow with URL: ${canonical}`);

  await ctx.reply(
    `🎬 *Re-clipping from video:*\n` +
    `🔗 \`${canonical}\`\n\n` +
    `Step 2 of 5:\n` +
    `Please send the *START* timestamp for the clip.\n\n` +
    `Format: MM:SS or HH:MM:SS\n` +
    `💡 Examples: \`01:15\` or \`01:05:30\`\n\n` +
    `Type /cancel anytime to abort.`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles callback query: history_reclip_<clipId>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleHistoryReclipCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const userId = ctx.from?.id;
  if (!userId) return;

  const match = ctx.callbackQuery?.data?.match(/^history_reclip_(\d+)$/);
  if (!match) return;

  const clip = await getClipRequestById(match[1], userId);
  if (!clip) {
    await ctx.reply('⚠️ Clip not found or access denied.');
    return;
  }

  await startReclipWithUrl(ctx, clip.youtube_url);
}

/**
 * Renders recent unique videos clipped by the user.
 *
 * @param {import('telegraf').Context} ctx
 * @param {number} [page=1]
 */
export async function renderRecentVideos(ctx, page = 1) {
  const userId = ctx.from?.id;
  if (!userId) return;

  await touchUser({
    telegramUserId: userId,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    lastName: ctx.from?.last_name,
  });

  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const totalVideos = await getRecentVideoCount(userId);
  const totalPages = Math.ceil(totalVideos / PAGE_SIZE) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const videos = await getRecentVideos(userId, { limit: PAGE_SIZE, offset });

  if (videos.length === 0) {
    const emptyText =
      '📚 *Recent Videos*\n\n' +
      '_No recent videos found in your history._\n\n' +
      'Send /clip to paste a YouTube URL and create your first clip!';
    const emptyKeyboard = [
      [Markup.button.callback('✂️ New YouTube URL', 'start_create_clip')],
      [Markup.button.callback('🔙 Account', 'start_my_account')],
    ];

    try {
      await ctx.editMessageText(emptyText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(emptyKeyboard),
      });
    } catch {
      await ctx.reply(emptyText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(emptyKeyboard),
      });
    }
    return;
  }

  let text = `📚 *Recent Videos* _(Page ${safePage}/${totalPages})_\n\n`;

  const videoButtons = [];

  videos.forEach((v, index) => {
    const count = v.clip_count;
    const clipWord = count === 1 ? 'clip' : 'clips';
    const videoKey = getUrlKey(v.canonical_url, v.video_id);

    text += `🎙 *YouTube Video*\n` +
            `   ${count} ${clipWord}\n` +
            `   ${v.canonical_url}\n\n`;

    videoButtons.push([
      Markup.button.callback(
        `🎙 Video ${offset + index + 1} (${count} ${clipWord})`,
        `recent_detail_${videoKey}`
      ),
    ]);
  });

  const buttons = [...videoButtons];

  // Pagination navigation row
  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback('◀ Prev', `recent_page_${safePage - 1}`));
  }
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback('Next ▶', `recent_page_${safePage + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([
    Markup.button.callback('✂️ New YouTube URL', 'start_create_clip'),
    Markup.button.callback('🔙 Account', 'start_my_account'),
  ]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

/**
 * Handles the /recent command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRecentVideosCommand(ctx) {
  await renderRecentVideos(ctx, 1);
}

/**
 * Handles callback query: recent_page_<page>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRecentPageCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^recent_page_(\d+)$/);
  const page = match ? parseInt(match[1], 10) : 1;
  await renderRecentVideos(ctx, page);
}

/**
 * Renders details of a selected recent video.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} videoKey
 */
export async function renderRecentVideoDetail(ctx, videoKey) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { canonicalUrl, videoId } = resolveUrlFromKey(videoKey);
  if (!canonicalUrl && !videoId) {
    await ctx.reply('⚠️ Video not found.');
    return;
  }

  const clips = await getRecentClipsForVideo(userId, canonicalUrl || videoId, { limit: 3, offset: 0 });
  const totalClips = await getUserClipCountForVideo(userId, canonicalUrl || videoId);

  if (totalClips === 0 && clips.length === 0) {
    await ctx.reply('⚠️ No clips found for this video in your account.');
    return;
  }

  const lastUsed = clips[0]?.requested_at ? formatRelativeTime(clips[0].requested_at) : 'Unknown';
  const displayUrl = clips[0]?.youtube_url || canonicalUrl;

  let clipsSummary = '';
  if (clips.length > 0) {
    clipsSummary = clips
      .map((c) => {
        const icon = getStatusIcon(c.status);
        const start = formatSeconds(c.start_seconds);
        const end = formatSeconds(c.end_seconds);
        return `${icon} \`${start}\` → \`${end}\``;
      })
      .join('\n');
  } else {
    clipsSummary = '_No clips found_';
  }

  const text =
    `🎬 *Recent Video*\n\n` +
    `*URL:*\n${displayUrl}\n\n` +
    `*Clips created:*\n${totalClips}\n\n` +
    `*Last used:*\n${lastUsed}\n\n` +
    `*Recent clips:*\n${clipsSummary}`;

  const buttons = [
    [Markup.button.callback('✂️ Create Another Clip', `recent_reclip_${videoKey}`)],
    [Markup.button.callback('📜 View All Clips', `recent_clips_${videoKey}_1`)],
    [Markup.button.callback('🔙 Recent Videos', 'recent_page_1')],
  ];

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

/**
 * Handles callback query: recent_detail_<key>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRecentDetailCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^recent_detail_(.+)$/);
  if (!match) return;

  await renderRecentVideoDetail(ctx, match[1]);
}

/**
 * Handles callback query: recent_reclip_<key>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRecentReclipCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^recent_reclip_(.+)$/);
  if (!match) return;

  const { canonicalUrl, videoId } = resolveUrlFromKey(match[1]);
  const targetUrl = canonicalUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
  if (!targetUrl) {
    await ctx.reply('⚠️ Video URL could not be resolved.');
    return;
  }

  await startReclipWithUrl(ctx, targetUrl);
}

/**
 * Renders all clips for a specific recent video.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} videoKey
 * @param {number} [page=1]
 */
export async function renderClipsForVideo(ctx, videoKey, page = 1) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { canonicalUrl, videoId } = resolveUrlFromKey(videoKey);
  const target = canonicalUrl || videoId;
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const totalClips = await getUserClipCountForVideo(userId, target);
  const totalPages = Math.ceil(totalClips / PAGE_SIZE) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const clips = await getRecentClipsForVideo(userId, target, { limit: PAGE_SIZE, offset });

  let text = `📜 *Clips for this Video* _(Page ${safePage}/${totalPages})_\n\n` +
             `🔗 ${canonicalUrl || 'YouTube Video'}\n\n`;

  const itemButtons = [];

  clips.forEach((clip, index) => {
    const itemNum = index + 1;
    const icon = getStatusIcon(clip.status);
    const startStr = formatSeconds(clip.start_seconds);
    const endStr = formatSeconds(clip.end_seconds);
    const timeStr = formatRelativeTime(clip.requested_at);
    const styleName = formatStyleName(clip.presentation_style);
    const capName = formatCaptionsLabel(clip.captions);

    text += `${itemNum}. ${icon} \`${startStr}\` → \`${endStr}\` (${styleName} · ${capName})\n` +
            `   ${timeStr}\n\n`;

    itemButtons.push(Markup.button.callback(`${itemNum}`, `history_clip_${clip.id}`));
  });

  const buttons = [];
  if (itemButtons.length > 0) {
    buttons.push(itemButtons);
  }

  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback('◀ Prev', `recent_clips_${videoKey}_${safePage - 1}`));
  }
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback('Next ▶', `recent_clips_${videoKey}_${safePage + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([
    Markup.button.callback('✂️ Create Another Clip', `recent_reclip_${videoKey}`),
    Markup.button.callback('🔙 Video Detail', `recent_detail_${videoKey}`),
  ]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

/**
 * Handles callback query: recent_clips_<key>_<page>.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleRecentClipsListCallback(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const match = ctx.callbackQuery?.data?.match(/^recent_clips_(.+)_\d+$/);
  if (!match) return;

  const data = ctx.callbackQuery.data;
  const lastUnderscore = data.lastIndexOf('_');
  const videoKey = data.slice('recent_clips_'.length, lastUnderscore);
  const page = parseInt(data.slice(lastUnderscore + 1), 10) || 1;

  await renderClipsForVideo(ctx, videoKey, page);
}
