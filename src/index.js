import { config } from './config/env.js';
import { createBot } from './bot/bot.js';
import { logger } from './utils/logger.js';
import { TELEGRAM_CLIPPER_BUILD } from './config/version.js';
import { getEncoderCapabilities } from './services/video/encoderCapabilities.js';
import { runMigrations } from './db/migrations.js';
import { closePool } from './db/pool.js';

async function bootstrap() {
  logger.info('================================================================');
  logger.info(`TELEGRAM_CLIPPER_BUILD=${TELEGRAM_CLIPPER_BUILD}`);
  logger.info(`Process PID: ${process.pid} | Parent PID: ${process.ppid}`);
  logger.info(`Current Working Directory: ${process.cwd()}`);
  logger.info(`Node: ${process.version} | Platform: ${process.platform}`);

  const caps = await getEncoderCapabilities();
  logger.info(`[ENCODER]\nNVENC available=${caps.gpuAvailable}\nencoder=${caps.preferredEncoder}`);
  logger.info(`[STARTUP_HARDWARE_CAPABILITIES] Preferred Encoder: ${caps.preferredEncoder}`);
  logger.info(`  • NVENC Support:   ${caps.nvenc} (live functional: ${caps.gpuAvailable})`);
  logger.info(`  • CUDA Accel:      ${caps.cuda}`);
  logger.info(`  • NVDEC Support:   ${caps.nvdec}`);
  logger.info(`  • Scale NPP:       ${caps.scaleNpp}`);
  logger.info(`  • Status Reason:   ${caps.reason}`);
  logger.info(
    `[TELEGRAM API]\n` +
    `base_url=${config.telegramApiBaseUrl}\n` +
    `local_api=${config.telegramLocalApi}`
  );

  // Initialize PostgreSQL database and execute migrations
  try {
    await runMigrations();
  } catch (dbErr) {
    logger.error('[DATABASE] Initialization warning/error:', dbErr.message);
  }

  const bot = createBot(config.telegramBotToken);

  // Health check Local Bot API if configured
  if (config.telegramLocalApi) {
    try {
      const me = await bot.telegram.getMe();
      logger.info(
        `[LOCAL BOT API]\n` +
        `reachable=true\n` +
        `base_url=${bot.telegram.options.apiRoot}`
      );
      logger.info(
        `[TELEGRAM CLIENT]\n` +
        `base_url=${bot.telegram.options.apiRoot}\n` +
        `local_api=true`
      );
    } catch (err) {
      const sanitizedErr = (err.message || '').replace(config.telegramBotToken, '[REDACTED]');
      logger.error(
        `[LOCAL BOT API]\n` +
        `reachable=false\n` +
        `base_url=${bot.telegram.options.apiRoot}\n` +
        `\n[CRITICAL] Local Telegram Bot API server is configured (TELEGRAM_LOCAL_API=true) but is unreachable at ${bot.telegram.options.apiRoot}.\n` +
        `Details: ${sanitizedErr}\n` +
        `-> FAILING FAST. Start telegram-bot-api --local on port 8081 or set TELEGRAM_LOCAL_API=false in .env.`
      );
      process.exit(1);
    }
  } else {
    logger.info(
      `[TELEGRAM CLIENT]\n` +
      `base_url=${bot.telegram.options.apiRoot}\n` +
      `local_api=false\n` +
      `50MB_restriction=ACTIVE`
    );
  }

  // Handle graceful stop
  const stopBot = async (signal) => {
    logger.info(`Received ${signal}. Stopping bot gracefully...`);
    bot.stop(signal);
    await closePool().catch(() => {});
    process.exit(0);
  };

  process.once('SIGINT', () => stopBot('SIGINT'));
  process.once('SIGTERM', () => stopBot('SIGTERM'));

  try {
    await bot.launch(() => {
      logger.info(
        `🚀 Telegram Clipper bot [@${bot.botInfo?.username || 'bot'}] [${TELEGRAM_CLIPPER_BUILD}] is online and listening for updates!`
      );
    });
  } catch (error) {
    logger.error('Failed to launch Telegram bot:', error);
    process.exit(1);
  }
}

bootstrap();
