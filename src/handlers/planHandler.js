import { Markup } from 'telegraf';
import {
  getUser,
  setUserPlan,
  isConfiguredOwner,
  PLAN_FREE,
  PLAN_PRO,
  ROLE_OWNER,
  ROLE_ADMIN,
} from '../db/userRepository.js';
import { logAdminAction, AdminActionType } from '../db/auditRepository.js';
import {
  recordSubscription,
  SubscriptionStatus,
} from '../db/subscriptionRepository.js';
import { isAdmin, canUseFeature, FEATURE_SQUARE_FOCUS } from '../services/authService.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Resolves current owner contact configuration dynamically.
 * Supports runtime environment overrides for testing.
 *
 * @returns {{ ownerUsername: string, priceDisplay: string, contactText: string }}
 */
export function getOwnerContactInfo() {
  const rawUsername = process.env.OWNER_TELEGRAM_USERNAME ?? config.ownerTelegramUsername ?? '';
  const ownerUsername = rawUsername.trim().replace(/^@/, '');
  const priceDisplay = (process.env.PRO_PRICE_DISPLAY ?? config.proPriceDisplay ?? '').trim();
  const contactText = (process.env.PRO_CONTACT_TEXT ?? config.proContactText ?? '').trim();
  return { ownerUsername, priceDisplay, contactText };
}

/**
 * Handles the /myplan command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleMyPlan(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const isUserAdmin = await isAdmin(userId);
  const user = await getUser(userId);
  const hasSquareFocus = await canUseFeature(userId, FEATURE_SQUARE_FOCUS);

  if (isUserAdmin || user?.role === ROLE_OWNER) {
    await ctx.reply(
      '👑 *Your plan: PRO (Administrator Access)*\n\n' +
      '*Available:*\n' +
      '✅ Standard presentation\n' +
      '✅ Square Focus (Cinematic 1:1 with blur)\n' +
      '✅ Full administrative rights\n' +
      '✅ Unlimited daily clips',
      { parse_mode: 'Markdown' }
    );
  } else if (hasSquareFocus || user?.plan === PLAN_PRO) {
    await ctx.reply(
      '🌟 *Your plan: PRO*\n\n' +
      '*Available:*\n' +
      '✅ Standard presentation\n' +
      '✅ Square Focus (Cinematic 1:1 with blur)\n' +
      '✅ 100 clips / day quota\n' +
      '✅ All kinetic caption styles',
      { parse_mode: 'Markdown' }
    );
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
    ]);
    await ctx.reply(
      '👤 *Your plan: FREE*\n\n' +
      '*Available:*\n' +
      '✅ Standard presentation\n' +
      '• 10 clips / day\n\n' +
      '*Locked:*\n' +
      '🔒 Square Focus\n' +
      '🔒 100 clips / day quota',
      { parse_mode: 'Markdown', ...keyboard }
    );
  }
}

/**
 * Renders the polished Telegram-native Manual PRO Upgrade screen.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderProUpgradeScreen(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {}

  const userId = ctx.from?.id;
  const user = userId ? await getUser(userId) : null;
  const isOwner = userId ? isConfiguredOwner(userId) : false;
  const role = isOwner ? ROLE_OWNER : (user?.role || 'USER');
  const plan = isOwner ? PLAN_PRO : (user?.plan || PLAN_FREE);

  // If user already has PRO or admin privileges
  if (role === ROLE_OWNER || role === ROLE_ADMIN || plan === PLAN_PRO) {
    const activeText =
      '⭐ *PRO Plan Active*\n\n' +
      'You already have full access to Telegram Clipper PRO:\n' +
      '• 100 clips / day (10x daily quota)\n' +
      '• Square Focus (Cinematic 1:1 with blur)\n' +
      '• All kinetic caption presets\n' +
      '• Priority NVENC hardware rendering';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back', 'start_my_account')],
    ]);

    try {
      await ctx.editMessageText(activeText, { parse_mode: 'Markdown', ...keyboard });
    } catch {
      await ctx.reply(activeText, { parse_mode: 'Markdown', ...keyboard });
    }
    return;
  }

  const { ownerUsername, priceDisplay, contactText } = getOwnerContactInfo();

  let text =
    '⭐ *Upgrade to PRO*\n\n' +
    '*Unlock:*\n' +
    '• 100 clips/day\n' +
    '• Square Focus\n' +
    '• Premium styles\n' +
    '• Higher usage limits\n\n';

  if (priceDisplay) {
    text += `💰 *Price:* ${priceDisplay}\n\n`;
  }

  text +=
    '💳 *Manual Upgrade*\n\n' +
    'To upgrade, contact the bot owner directly.\n\n';

  if (contactText) {
    text += `${contactText}\n\n`;
  }

  const ownerDisplay = ownerUsername ? `@${ownerUsername}` : 'Please contact the bot owner.';

  text +=
    `📩 *Contact:*\n` +
    `${ownerDisplay}\n\n` +
    'After payment is confirmed manually, the owner will activate PRO for your account.';

  const buttons = [];
  if (ownerUsername) {
    buttons.push([Markup.button.url('📩 Contact Owner', `https://t.me/${ownerUsername}`)]);
  } else {
    buttons.push([Markup.button.callback('📩 Contact Owner', 'manual_contact_owner_info')]);
  }
  buttons.push([Markup.button.callback('🔙 Back', 'start_my_account')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

/**
 * Legacy modal route redirected to the manual upgrade screen.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function renderProSubscriptionModal(ctx) {
  await renderProUpgradeScreen(ctx);
}

/**
 * Handles callback when contact owner button is clicked but no username is configured.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleManualContactOwnerInfo(ctx) {
  try {
    await ctx.answerCbQuery('Please contact the bot owner directly.', { show_alert: true });
  } catch {}
}

/**
 * Handles legacy notify_me callback gracefully by advising manual upgrade.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleNotifyMeCallback(ctx) {
  try {
    await ctx.answerCbQuery('To upgrade to PRO, please contact the bot owner.', { show_alert: true });
  } catch {}
  await renderProUpgradeScreen(ctx);
}

/**
 * Handles the /pro command.
 * If called with a user ID by an admin, grants PRO.
 * If called by a regular user or without target ID, displays the PRO Upgrade Screen.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleProCommand(ctx) {
  const callerId = ctx.from?.id;
  if (!callerId) return;

  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const targetId = parts[1]?.trim();

  // If a target ID is provided and caller is admin, execute admin upgrade
  if (targetId && (await isAdmin(callerId))) {
    if (!/^\d+$/.test(targetId)) {
      await ctx.reply('⚠️ Usage: `/pro <telegramUserId>`\nExample: `/pro 7650707467`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      await setUserPlan(targetId, PLAN_PRO);
      await logAdminAction({
        adminUserId: callerId,
        targetUserId: targetId,
        action: AdminActionType.GRANT_PRO,
        metadata: { source: 'command_/pro' },
      });

      await recordSubscription({
        telegramUserId: targetId,
        plan: PLAN_PRO,
        status: SubscriptionStatus.ACTIVE,
        provider: 'ADMIN',
      });

      await ctx.reply(`✅ User \`${targetId}\` has been upgraded to *PRO*.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
    return;
  }

  // Otherwise, display the PRO Upgrade Screen
  await renderProUpgradeScreen(ctx);
}

/**
 * Handles the /unpro <telegramUserId> admin command.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleUnproCommand(ctx) {
  const callerId = ctx.from?.id;
  if (!callerId || !(await isAdmin(callerId))) {
    logger.warn(`Unauthorized /unpro attempt by user ${callerId}`);
    await ctx.reply('⛔ Unauthorized: This command is restricted to administrators.');
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const targetId = parts[1]?.trim();

  if (!targetId || !/^\d+$/.test(targetId)) {
    await ctx.reply('⚠️ Usage: `/unpro <telegramUserId>`\nExample: `/unpro 7650707467`', { parse_mode: 'Markdown' });
    return;
  }

  if (isConfiguredOwner(targetId)) {
    await ctx.reply('❌ Protected account: The OWNER cannot lose PRO status.');
    return;
  }

  try {
    await setUserPlan(targetId, PLAN_FREE);
    await logAdminAction({
      adminUserId: callerId,
      targetUserId: targetId,
      action: AdminActionType.REMOVE_PRO,
      metadata: { source: 'command_/unpro' },
    });

    await recordSubscription({
      telegramUserId: targetId,
      plan: PLAN_PRO,
      status: SubscriptionStatus.CANCELLED,
      provider: 'ADMIN',
    });

    await ctx.reply(`✅ User \`${targetId}\` has been set to *FREE*.`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

/**
 * Handles legacy or informational upgrade callbacks by routing to the PRO upgrade screen.
 *
 * @param {import('telegraf').Context} ctx
 */
export async function handleUpgradeProInfo(ctx) {
  await renderProUpgradeScreen(ctx);
}


