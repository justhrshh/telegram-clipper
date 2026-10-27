/**
 * Admin Panel & User Management Handler
 *
 * Provides interactive Telegram UI for administrators:
 * - Real-time metrics dashboard
 * - Paginated user management
 * - Granular access control (enable/disable) with strict Owner protection
 * - PRO entitlement toggling
 * - Search by Telegram ID or @username
 * - 7-day ASCII usage chart and top users
 * - User clip request history
 */

import { Markup } from 'telegraf';
import {
  getUser,
  findUserByIdOrUsername,
  listUsers,
  setUserAccess,
  setUserPlan,
  getDashboardStats,
  getTopUsers,
  getDailyStats,
  isConfiguredOwner,
  ROLE_OWNER,
  PLAN_PRO,
  PLAN_FREE,
} from '../db/userRepository.js';
import { getUserClipRequests } from '../db/clipRequestRepository.js';
import { logAdminAction, AdminActionType } from '../db/auditRepository.js';
import {
  recordSubscription,
  SubscriptionStatus,
  getProInterestCount,
  getProInterestedUsers,
} from '../db/subscriptionRepository.js';
import { isAdmin, isOwner, getRemainingDailyQuota } from '../services/authService.js';
import { getYouTubeAuthStatus, saveCookiesFile, removeCookiesFile } from '../services/youtube/youtubeAuth.js';
import { escapeTelegramMarkdown } from '../utils/telegramFormat.js';
import { logger } from '../utils/logger.js';

// Ephemeral map to track admin search state: adminUserId -> true
const adminSearchSessions = new Map();

/**
 * Renders the primary Admin Dashboard summary.
 *
 * @param {import('telegraf').Context} ctx
 * @param {boolean} isEdit - Whether to edit existing message or send a new one
 */
export async function renderDashboard(ctx, isEdit = false) {
  const userId = ctx.from?.id;
  if (!userId || !(await isAdmin(userId))) {
    if (!isEdit) {
      await ctx.reply('⛔ Access denied. This command is restricted to administrators.');
    }
    return;
  }

  adminSearchSessions.delete(String(userId));

  const stats = await getDashboardStats();
  const proInterestCount = await getProInterestCount();

  const text =
    '🛠️ *Admin Dashboard*\n\n' +
    '📊 *Live Platform Overview:*\n' +
    `• *Total Users:* \`${escapeTelegramMarkdown(stats.total_users)}\`\n` +
    `• *PRO Users:* \`${escapeTelegramMarkdown(stats.pro_users)}\`\n` +
    `• *PRO Interest:* \`${escapeTelegramMarkdown(proInterestCount)} users\`\n` +
    `• *Disabled Users:* \`${escapeTelegramMarkdown(stats.disabled_users)}\`\n` +
    `• *Requests Today:* \`${escapeTelegramMarkdown(stats.requests_today)}\`\n` +
    `• *Total Clips (All-time):* \`${escapeTelegramMarkdown(stats.total_clips)}\`\n` +
    `• *Successful Clips:* \`${escapeTelegramMarkdown(stats.successful_clips)}\`\n` +
    `• *Failed Clips:* \`${escapeTelegramMarkdown(stats.failed_clips)}\`\n\n` +
    '_Select an action below:_';

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('👥 Users List', 'admin_users_page_1'),
      Markup.button.callback('📊 Statistics', 'admin_stats'),
    ],
    [
      Markup.button.callback(`⭐ PRO Interest (${proInterestCount})`, 'admin_pro_interest_1'),
      Markup.button.callback('🔍 Search User', 'admin_search_prompt'),
    ],
    [
      Markup.button.callback('🍪 YouTube Cookies', 'admin_yt_cookies'),
    ],
  ]);

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      return;
    } catch {}
  }

  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

/**
 * Handles the /admin command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleAdminCommand(ctx) {
  const userId = ctx.from?.id;
  if (!userId || !(await isAdmin(userId))) {
    await ctx.reply('⛔ Access denied. This command is restricted to administrators.');
    return;
  }

  await renderDashboard(ctx, false);
}

/**
 * Renders a paginated list of users.
 *
 * @param {import('telegraf').Context} ctx
 * @param {number} page
 */
export async function renderUsersList(ctx, page = 1) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const { users, total, totalPages } = await listUsers({ page, limit: 5 });

  let text = `👥 *User Management* (Page ${page}/${totalPages} • Total: ${total})\n\n`;

  const buttons = [];

  if (users.length === 0) {
    text += '_No users found._\n';
  } else {
    for (const u of users) {
      const usernameRaw = u.username ? `@${u.username}` : (u.first_name || 'Anonymous');
      const safeUsername = escapeTelegramMarkdown(usernameRaw);
      const safeUserId = escapeTelegramMarkdown(u.telegram_user_id);
      const roleBadge = u.role === ROLE_OWNER ? '👑 OWNER' : u.role === 'ADMIN' ? '🛡️ ADMIN' : '👤 USER';
      const planBadge = u.plan === PLAN_PRO ? '⭐ PRO' : 'FREE';
      const statusBadge = u.access_enabled ? '✅' : '🚫';

      text += `${statusBadge} *${safeUsername}* (\`${safeUserId}\`)\n` +
              `   └ ${roleBadge} | ${planBadge} | Clips: ${u.total_clips || 0}\n\n`;

      buttons.push([
        Markup.button.callback(
          `Manage ${usernameRaw.slice(0, 16)} (${u.telegram_user_id})`,
          `admin_user_${u.telegram_user_id}`
        ),
      ]);
    }
  }

  // Pagination navigation row
  const navRow = [];
  if (page > 1) {
    navRow.push(Markup.button.callback('◀ Prev', `admin_users_page_${page - 1}`));
  }
  if (page < totalPages) {
    navRow.push(Markup.button.callback('Next ▶', `admin_users_page_${page + 1}`));
  }

  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([Markup.button.callback('🔙 Back to Dashboard', 'admin_dashboard')]);

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
 * Renders the detailed view and management card for a specific user.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} targetUserId
 */
export async function renderUserDetail(ctx, targetUserId) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const user = await getUser(targetUserId);
  if (!user) {
    try {
      await ctx.answerCbQuery('User not found.');
    } catch {}
    await ctx.reply(`⚠️ User \`${escapeTelegramMarkdown(targetUserId)}\` was not found in the database.`, { parse_mode: 'Markdown' });
    return;
  }

  const isTargetOwner = isConfiguredOwner(user.telegram_user_id) || user.role === ROLE_OWNER;
  const usernameDisplay = user.username ? `@${user.username}` : 'None';
  const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'None';
  const roleDisplay = isTargetOwner ? '👑 OWNER (Protected)' : user.role === 'ADMIN' ? '🛡️ ADMIN' : '👤 USER';
  const planDisplay = user.plan === PLAN_PRO ? '⭐ PRO' : '🆓 FREE';
  const statusDisplay = user.access_enabled ? '✅ Active' : '🚫 Disabled';
  const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).toISOString().replace('T', ' ').slice(0, 19) : 'Never';
  const lastReq = user.last_request_at ? new Date(user.last_request_at).toISOString().replace('T', ' ').slice(0, 19) : 'Never';

  const quota = await getRemainingDailyQuota(user.telegram_user_id);
  const todayDisplay = quota.isUnlimited ? 'Unlimited' : `${quota.usage}/${quota.limit}`;
  const limitDisplay = quota.isUnlimited ? 'Unlimited' : `${quota.limit} clips/day`;

  const text =
    `👤 *User Card: ${escapeTelegramMarkdown(user.telegram_user_id)}*\n\n` +
    `• *Username:* ${escapeTelegramMarkdown(usernameDisplay)}\n` +
    `• *Name:* ${escapeTelegramMarkdown(fullName)}\n` +
    `• *Role:* ${roleDisplay}\n` +
    `• *Plan:* ${planDisplay}\n` +
    `• *Status:* ${statusDisplay}\n\n` +
    `📊 *Usage & Limits:*\n` +
    `• *Today:* \`${todayDisplay}\`\n` +
    `• *Daily Limit:* \`${limitDisplay}\`\n` +
    `• *Total Requests:* \`${user.total_requests || 0}\`\n` +
    `• *Total Clips:* \`${user.total_clips || 0}\`\n` +
    `• *Successful:* \`${user.successful_clips || 0}\`\n` +
    `• *Failed:* \`${user.failed_clips || 0}\`\n\n` +
    `🕒 *Timestamps:*\n` +
    `• *Last Seen:* \`${lastSeen}\`\n` +
    `• *Last Request:* \`${lastReq}\`\n`;

  const buttons = [];

  // PRO Toggle Button
  if (!isTargetOwner) {
    if (user.plan === PLAN_PRO) {
      buttons.push([Markup.button.callback('❌ Revoke PRO', `admin_toggle_pro_${user.telegram_user_id}`)]);
    } else {
      buttons.push([Markup.button.callback('⭐ Grant PRO', `admin_toggle_pro_${user.telegram_user_id}`)]);
    }

    // Access Toggle Button
    if (user.access_enabled) {
      buttons.push([Markup.button.callback('🚫 Disable Access', `admin_toggle_access_${user.telegram_user_id}`)]);
    } else {
      buttons.push([Markup.button.callback('✅ Enable Access', `admin_toggle_access_${user.telegram_user_id}`)]);
    }
  } else {
    buttons.push([Markup.button.callback('🔒 Account Protected (OWNER)', 'admin_protected_alert')]);
  }

  // Clip history button
  buttons.push([Markup.button.callback('📜 Clip History', `admin_history_${user.telegram_user_id}`)]);
  buttons.push([Markup.button.callback('🔙 Back to Users', 'admin_users_page_1')]);

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
 * Toggles a user's PRO plan status with Owner protection.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} targetUserId
 */
export async function handleTogglePro(ctx, targetUserId) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  if (isConfiguredOwner(targetUserId)) {
    try {
      await ctx.answerCbQuery('❌ This account is protected. The OWNER cannot lose PRO status.', { show_alert: true });
    } catch {}
    return;
  }

  const user = await getUser(targetUserId);
  if (!user) return;

  const newPlan = user.plan === PLAN_PRO ? PLAN_FREE : PLAN_PRO;
  await setUserPlan(targetUserId, newPlan);

  await logAdminAction({
    adminUserId: adminId,
    targetUserId,
    action: newPlan === PLAN_PRO ? AdminActionType.GRANT_PRO : AdminActionType.REMOVE_PRO,
    metadata: { previousPlan: user.plan, newPlan },
  });

  await recordSubscription({
    telegramUserId: targetUserId,
    plan: PLAN_PRO,
    status: newPlan === PLAN_PRO ? SubscriptionStatus.ACTIVE : SubscriptionStatus.CANCELLED,
    provider: 'ADMIN',
  });

  try {
    await ctx.answerCbQuery(`User plan set to ${newPlan}`);
  } catch {}

  await renderUserDetail(ctx, targetUserId);
}

/**
 * Toggles a user's bot access with Owner protection.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} targetUserId
 */
export async function handleToggleAccess(ctx, targetUserId) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  if (isConfiguredOwner(targetUserId)) {
    try {
      await ctx.answerCbQuery('❌ This account is protected. The OWNER cannot be disabled.', { show_alert: true });
    } catch {}
    return;
  }

  const user = await getUser(targetUserId);
  if (!user) return;

  const newAccess = !user.access_enabled;
  await setUserAccess(targetUserId, newAccess);

  await logAdminAction({
    adminUserId: adminId,
    targetUserId,
    action: newAccess ? AdminActionType.ENABLE_ACCESS : AdminActionType.DISABLE_ACCESS,
    metadata: { previousAccess: user.access_enabled, newAccess },
  });

  try {
    await ctx.answerCbQuery(`User access ${newAccess ? 'enabled' : 'disabled'}`);
  } catch {}

  await renderUserDetail(ctx, targetUserId);
}

/**
 * Displays recent clip requests for a user.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string|number} targetUserId
 */
export async function renderUserHistory(ctx, targetUserId) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const clips = await getUserClipRequests(targetUserId, { limit: 5 });

  let text = `📜 *Recent Clip Requests for User* \`${escapeTelegramMarkdown(targetUserId)}\`:\n\n`;

  if (clips.length === 0) {
    text += '_No clip requests found for this user._\n';
  } else {
    for (const c of clips) {
      const statusIcon = c.status === 'COMPLETED' ? '✅' : c.status === 'FAILED' ? '❌' : '⏳';
      const timeStr = c.requested_at ? new Date(c.requested_at).toISOString().replace('T', ' ').slice(0, 16) : '';
      text += `${statusIcon} *${escapeTelegramMarkdown(c.status)}* [${escapeTelegramMarkdown(c.presentation_style || 'standard')}]\n` +
              `   • Job: \`${escapeTelegramMarkdown(c.job_id || 'N/A')}\`\n` +
              `   • Time: \`${escapeTelegramMarkdown(timeStr)}\`\n` +
              `   • URL: ${escapeTelegramMarkdown(c.youtube_url ? c.youtube_url.slice(0, 40) + '...' : 'N/A')}\n\n`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to User', `admin_user_${targetUserId}`)],
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

/**
 * Renders platform statistics and the 7-day ASCII usage chart.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderStats(ctx) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const daily = await getDailyStats(7);
  const topUsers = await getTopUsers(5);

  let chartText = '📊 *7-Day Usage Activity*\n```\n';
  const maxCount = Math.max(1, ...daily.map((d) => d.count));

  for (const d of daily) {
    const barLength = Math.round((d.count / maxCount) * 12);
    const bar = '█'.repeat(barLength) || (d.count > 0 ? '▏' : ' ');
    const label = d.day.slice(5); // MM-DD
    chartText += `${label} | ${bar.padEnd(12, ' ')} (${d.count})\n`;
  }
  chartText += '```\n';

  let topText = '🏆 *Top 5 Users by Clips:*\n';
  if (topUsers.length === 0) {
    topText += '_No clip activity recorded yet._\n';
  } else {
    topUsers.forEach((u, i) => {
      const rawName = u.username ? `@${u.username}` : (u.first_name || u.telegram_user_id);
      topText += `${i + 1}. *${escapeTelegramMarkdown(rawName)}* — \`${u.total_clips || 0}\` clips (req: ${u.total_requests || 0})\n`;
    });
  }

  const text = `${chartText}\n${topText}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back to Dashboard', 'admin_dashboard')],
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

/**
 * Renders paginated list of users who expressed interest in PRO subscriptions.
 *
 * @param {import('telegraf').Context} ctx
 * @param {number} page
 */
export async function renderProInterestList(ctx, page = 1) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const limit = 5;
  const offset = (page - 1) * limit;
  const total = await getProInterestCount();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const interestedUsers = await getProInterestedUsers({ limit, offset });

  let text = `⭐ *PRO Subscriptions Interest* (Page ${page}/${totalPages} • Total: ${total})\n\n` +
    '_Users who requested notification when PRO subscriptions launch:_\n\n';

  const buttons = [];

  if (interestedUsers.length === 0) {
    text += '_No users have registered interest yet._\n';
  } else {
    for (const u of interestedUsers) {
      const usernameRaw = u.username ? `@${u.username}` : (u.first_name || 'Anonymous');
      const safeUsername = escapeTelegramMarkdown(usernameRaw);
      const safeUserId = escapeTelegramMarkdown(u.telegram_user_id);
      const dateStr = u.created_at ? new Date(u.created_at).toISOString().replace('T', ' ').slice(0, 16) : 'Unknown';
      text += `• *${safeUsername}* (\`${safeUserId}\`)\n` +
              `   └ Registered: ${dateStr} | Plan: ${escapeTelegramMarkdown(u.plan || 'FREE')}\n\n`;

      buttons.push([
        Markup.button.callback(
          `Manage ${usernameRaw.slice(0, 16)} (${u.telegram_user_id})`,
          `admin_user_${u.telegram_user_id}`
        ),
      ]);
    }
  }

  const navRow = [];
  if (page > 1) {
    navRow.push(Markup.button.callback('◀ Prev', `admin_pro_interest_${page - 1}`));
  }
  if (page < totalPages) {
    navRow.push(Markup.button.callback('Next ▶', `admin_pro_interest_${page + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([Markup.button.callback('🔙 Back to Dashboard', 'admin_dashboard')]);

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
 * Prompts the admin to enter a user ID or @username to search.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleSearchPrompt(ctx) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  adminSearchSessions.set(String(adminId), true);

  try {
    await ctx.answerCbQuery();
  } catch {}

  await ctx.reply(
    '🔍 *Search User*\n\n' +
    'Please enter the *Telegram User ID* or *@username* of the user you wish to find:\n\n' +
    '_Type /cancel to abort search._',
    { parse_mode: 'Markdown' }
  );
}

/**
 * Checks if an admin has an active search prompt.
 *
 * @param {string|number} adminId
 * @returns {boolean}
 */
export function isAdminSearching(adminId) {
  return adminSearchSessions.has(String(adminId));
}

/**
 * Processes search input from an admin.
 *
 * @param {import('telegraf').Context} ctx
 * @returns {Promise<boolean>} True if handled, false if not searching
 */
export async function handleSearchInput(ctx) {
  const adminId = ctx.from?.id;
  if (!adminId || !isAdminSearching(adminId)) return false;

  const queryText = ctx.message?.text?.trim();
  adminSearchSessions.delete(String(adminId));

  if (!queryText || queryText.startsWith('/')) {
    return false;
  }

  const user = await findUserByIdOrUsername(queryText);
  if (!user) {
    await ctx.reply(
      `⚠️ No user found matching \`${escapeTelegramMarkdown(queryText)}\`.\n\nUse /admin to return to the dashboard.`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  await renderUserDetail(ctx, user.telegram_user_id);
  return true;
}

/**
 * Router for all admin callback queries (action data starting with admin_).
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleAdminAction(ctx) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) {
    try {
      await ctx.answerCbQuery('⛔ Unauthorized.', { show_alert: true });
    } catch {}
    return;
  }

  const action = ctx.callbackQuery?.data;
  if (!action) return;

  try {
    if (action === 'admin_dashboard') {
      await renderDashboard(ctx, true);
    } else if (action.startsWith('admin_users_page_')) {
      const page = parseInt(action.replace('admin_users_page_', ''), 10) || 1;
      await renderUsersList(ctx, page);
    } else if (action.startsWith('admin_user_')) {
      const targetId = action.replace('admin_user_', '');
      await renderUserDetail(ctx, targetId);
    } else if (action.startsWith('admin_toggle_pro_')) {
      const targetId = action.replace('admin_toggle_pro_', '');
      await handleTogglePro(ctx, targetId);
    } else if (action.startsWith('admin_toggle_access_')) {
      const targetId = action.replace('admin_toggle_access_', '');
      await handleToggleAccess(ctx, targetId);
    } else if (action.startsWith('admin_history_')) {
      const targetId = action.replace('admin_history_', '');
      await renderUserHistory(ctx, targetId);
    } else if (action === 'admin_stats') {
      await renderStats(ctx);
    } else if (action === 'admin_search_prompt') {
      await handleSearchPrompt(ctx);
    } else if (action.startsWith('admin_pro_interest_')) {
      const page = parseInt(action.replace('admin_pro_interest_', ''), 10) || 1;
      await renderProInterestList(ctx, page);
    } else if (action === 'admin_pro_interest') {
      await renderProInterestList(ctx, 1);
    } else if (action === 'admin_yt_cookies') {
      await renderYouTubeAuthPanel(ctx, true);
    } else if (action === 'admin_remove_cookies') {
      const removed = removeCookiesFile();
      if (removed) {
        await ctx.answerCbQuery('🗑️ cookies.txt removed successfully.', { show_alert: true });
      } else {
        await ctx.answerCbQuery('No cookies file found.', { show_alert: true });
      }
      await renderYouTubeAuthPanel(ctx, true);
    } else if (action === 'admin_protected_alert') {
      await ctx.answerCbQuery('❌ This account is protected. OWNER cannot be modified.', { show_alert: true });
    }
  } catch (err) {
    logger.error(`[ADMIN_ACTION_ERROR] Action: ${action} Error:`, err.message);
    try {
      await ctx.answerCbQuery(`Error: ${err.message}`, { show_alert: true });
    } catch {}
  }
}

/**
 * Renders YouTube Auth & Cookies management panel.
 *
 * @param {import('telegraf').Context} ctx
 * @param {boolean} isEdit
 */
export async function renderYouTubeAuthPanel(ctx, isEdit = true) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return;

  const authStatus = getYouTubeAuthStatus();

  const statusIcon = authStatus.hasCookiesFile ? '✅' : '⚡';
  const statusText = authStatus.hasCookiesFile
    ? `*Cookies Active*\n• File: \`cookies.txt\` (${(authStatus.fileSize / 1024).toFixed(1)} KB)`
    : '*No Cookies File Installed*\n• Automatic mobile InnerTube bypass is active (resolves public clips)';

  const text =
    '🍪 *YouTube Authentication & Cookies*\n\n' +
    `${statusIcon} *Current Status:* ${statusText}\n\n` +
    '📥 *How to add or update cookies:*\n' +
    '1. Open YouTube in your browser while signed in.\n' +
    '2. Export cookies using an extension like *Get cookies.txt LOCALLY*.\n' +
    '3. Upload or forward the `.txt` file into this chat.\n\n' +
    '_The bot will immediately activate the cookies for all clip downloads._';

  const buttons = [];
  if (authStatus.hasCookiesFile) {
    buttons.push([Markup.button.callback('🗑️ Remove Cookies', 'admin_remove_cookies')]);
  }
  buttons.push([
    Markup.button.callback('🔄 Refresh Status', 'admin_yt_cookies'),
    Markup.button.callback('⬅️ Back to Dashboard', 'admin_dashboard'),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      return;
    } catch {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

/**
 * Handles incoming document uploads from admins (for installing cookies.txt).
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleAdminDocument(ctx) {
  const adminId = ctx.from?.id;
  if (!adminId || !(await isAdmin(adminId))) return false;

  const doc = ctx.message?.document;
  if (!doc) return false;

  const fileName = (doc.file_name || '').toLowerCase();
  if (!fileName.endsWith('.txt') && !fileName.includes('cookie')) {
    return false;
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await fetch(fileLink.href);
    const text = await resp.text();

    if (!text.includes('.youtube.com') && !text.includes('# Netscape') && !text.includes('\t')) {
      await ctx.reply(
        '⚠️ The uploaded file does not appear to be a valid YouTube Netscape cookies file.\n\nPlease ensure you export cookies in Netscape format.'
      );
      return true;
    }

    const res = saveCookiesFile(text);
    await ctx.reply(
      `✅ *YouTube Cookies Installed Successfully!*\n\n` +
      `• File: \`cookies.txt\`\n` +
      `• Size: \`${(res.size / 1024).toFixed(1)} KB\`\n\n` +
      `All subsequent YouTube downloads will now use this authenticated session!`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (err) {
    logger.error('[ADMIN_COOKIE_UPLOAD] Failed to save uploaded cookies:', err.message);
    await ctx.reply(`❌ Failed to save cookies file: ${err.message}`);
    return true;
  }
}
