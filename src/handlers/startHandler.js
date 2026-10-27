import { Markup } from 'telegraf';
import { resetSession } from '../session/sessionStore.js';
import { isAdmin } from '../services/authService.js';
import { getUser, isConfiguredOwner, PLAN_PRO, ROLE_OWNER, ROLE_ADMIN } from '../db/userRepository.js';
import { logger } from '../utils/logger.js';

/**
 * Builds the clean main start menu message and inline keyboard buttons.
 *
 * @param {string|number} userId
 * @returns {Promise<{ welcomeMessage: string, keyboard: object }>}
 */
export async function getStartMenuData(userId) {
  const buttons = [
    [Markup.button.callback('✂️ Create Clip', 'start_create_clip')],
    [Markup.button.callback('👤 My Account', 'start_my_account')],
    [
      Markup.button.callback('📜 My Clips', 'history_page_1'),
      Markup.button.callback('📚 Recent Videos', 'recent_page_1'),
    ],
  ];

  if (userId) {
    const isUserAdmin = await isAdmin(userId);
    const user = await getUser(userId);
    const isOwner = isConfiguredOwner(userId);
    const role = isOwner ? ROLE_OWNER : (user?.role || 'USER');
    const isPro = user?.plan === PLAN_PRO || isOwner || role === ROLE_ADMIN;

    if (isOwner || isUserAdmin) {
      buttons.push([Markup.button.callback('🛠 Admin Panel', 'admin_dashboard')]);
    } else if (isPro) {
      buttons.push([Markup.button.callback('⭐ PRO Active', 'upgrade_pro_active_info')]);
    } else {
      buttons.push([Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')]);
    }
  }

  const welcomeMessage =
    '🎬 *Telegram Clipper*\n\n' +
    'Turn YouTube videos into ready-to-post clips.';

  return { welcomeMessage, keyboard: Markup.inlineKeyboard(buttons) };
}

/**
 * Renders the clean main menu, optionally editing the existing message in-place.
 *
 * @param {import('telegraf').Context} ctx
 * @param {boolean} [isEdit=false]
 */
export async function renderStartMenu(ctx, isEdit = false) {
  const userId = ctx.from?.id;
  const { welcomeMessage, keyboard } = await getStartMenuData(userId);

  if (isEdit) {
    try {
      await ctx.editMessageText(welcomeMessage, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
      return;
    } catch (err) {
      if (err.message?.includes('message is not modified')) return;
      logger.debug('Failed to editMessageText for start menu, falling back to reply:', err.message);
    }
  }

  await ctx.reply(welcomeMessage, {
    parse_mode: 'Markdown',
    ...keyboard,
  });
}

/**
 * Handles the /start command.
 * Sends a welcome message explaining the bot's features and instructions.
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleStart(ctx) {
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name || 'Creator';

  if (userId) {
    resetSession(userId);
  }

  logger.info(`User ${userId} (${firstName}) sent /start`);
  await renderStartMenu(ctx, false);
}

/**
 * Handles the /help command.
 *
 * @param {import('telegraf').Context} ctx 
 */
export async function handleHelp(ctx) {
  const helpMessage =
    '📖 *Telegram Clipper Help*\n\n' +
    '• */clip*: Start creating a new clip\n' +
    '• */account*: View plan & daily limits\n' +
    '• */history*: View your clip history\n' +
    '• */recent*: View recently clipped videos\n' +
    '• */cancel*: Abort ongoing clip session\n\n' +
    'Timestamp formats: `MM:SS` (e.g. `01:15`) or `HH:MM:SS` (e.g. `01:05:30`).';

  await ctx.replyWithMarkdown(helpMessage);
}
