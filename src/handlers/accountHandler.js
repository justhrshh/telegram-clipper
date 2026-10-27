/**
 * Account Handler (/account)
 *
 * Displays user profile, current tier/role, daily quota usage, lifetime metrics,
 * and account creation timestamp directly from PostgreSQL.
 */

import { Markup } from 'telegraf';
import {
  getUser,
  isConfiguredOwner,
  ROLE_OWNER,
  ROLE_ADMIN,
  PLAN_PRO,
} from '../db/userRepository.js';
import { getUserClipRequests } from '../db/clipRequestRepository.js';
import {
  getDailyUsage,
  getRemainingDailyQuota,
  isAdmin,
  getRole,
} from '../services/authService.js';
import { getPlanLimits } from '../config/planLimits.js';
import { logger } from '../utils/logger.js';

/**
 * Formats a Date into '14 Sep 2026' style.
 *
 * @param {Date|string} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date) return 'Unknown';
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'Unknown';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return 'Unknown';
  }
}

/**
 * Handles the /account command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleAccountCommand(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await getUser(userId);
  const isOwner = isConfiguredOwner(userId);
  const role = isOwner ? ROLE_OWNER : (user?.role || 'USER');
  const plan = isOwner ? 'PRO' : (user?.plan || 'FREE');

  const fullName = `${user?.first_name || ctx.from?.first_name || ''} ${user?.last_name || ctx.from?.last_name || ''}`.trim() || 'Not set';
  const usernameDisplay = user?.username ? `@${user.username}` : (ctx.from?.username ? `@${ctx.from.username}` : 'Not set');

  // Plan badge
  let planBadge = '🆓 FREE';
  if (role === ROLE_OWNER) {
    planBadge = '⭐ OWNER';
  } else if (role === ROLE_ADMIN) {
    planBadge = '⭐ ADMIN';
  } else if (plan === PLAN_PRO) {
    planBadge = '⭐ PRO';
  }

  // Access badge
  const isAccessActive = isOwner || role === ROLE_ADMIN || Boolean(user?.access_enabled ?? true);
  const accessBadge = isAccessActive ? '✅ Active' : '🚫 Disabled';

  // Usage calculations
  let usageText = 'Unlimited';
  if (role !== ROLE_OWNER && role !== ROLE_ADMIN) {
    const usageToday = await getDailyUsage(userId);
    const limits = getPlanLimits(role, plan);
    usageText = `${usageToday} / ${limits.dailyClips} clips`;
  }

  const createdStr = formatDate(user?.created_at || new Date());

  const text =
    '👤 *My Account*\n\n' +
    `*Name:* ${fullName}\n` +
    `*Username:* ${usernameDisplay}\n` +
    `*Telegram ID:* \`${userId}\`\n\n` +
    `*Plan:* ${planBadge}\n` +
    `*Access:* ${accessBadge}\n\n` +
    `📊 *Today's Usage*\n` +
    `${usageText}\n\n` +
    `📈 *Lifetime*\n` +
    `• *Requests:* ${user?.total_requests || 0}\n` +
    `• *Successful:* ${user?.successful_clips || 0}\n` +
    `• *Failed:* ${user?.failed_clips || 0}\n\n` +
    `🕒 *Created:*\n` +
    `${createdStr}`;

  const buttons = [
    [
      Markup.button.callback('✂️ Create Clip', 'account_create_clip'),
      Markup.button.callback('📜 Clip History', 'account_clip_history'),
    ],
    [
      Markup.button.callback('📚 Recent Videos', 'recent_page_1'),
    ],
  ];

  // Show upgrade CTA if user is FREE, or PRO Active badge if PRO
  if (role !== ROLE_OWNER && role !== ROLE_ADMIN) {
    if (plan === PLAN_PRO) {
      buttons.push([Markup.button.callback('⭐ PRO Active', 'upgrade_pro_active_info')]);
    } else {
      buttons.push([Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')]);
    }
  }

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
 * Handles user clip history display.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleMyClipHistory(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const { renderClipHistory } = await import('./historyHandler.js');
  await renderClipHistory(ctx, 1);
}
