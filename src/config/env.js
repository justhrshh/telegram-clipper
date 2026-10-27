import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

// Resolve .env path explicitly to guarantee loading from D:\telegram-clipper\.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cwdEnvPath = path.resolve(process.cwd(), '.env');
const fallbackEnvPath = path.resolve(__dirname, '../../.env');
const resolvedEnvPath = fs.existsSync(cwdEnvPath) ? cwdEnvPath : fallbackEnvPath;

// Load environment variables with explicit path
dotenv.config({ path: resolvedEnvPath });

const rawLocalApi = process.env.TELEGRAM_LOCAL_API;
const rawApiBaseUrl = process.env.TELEGRAM_API_BASE_URL;

// Case-insensitive, whitespace-safe boolean resolution: "true", "TRUE", "True", "1", "yes"
const isLocalApi = typeof rawLocalApi === 'string' && ['true', '1', 'yes'].includes(rawLocalApi.trim().toLowerCase());

// Base URL resolution
let resolvedApiBaseUrl = (rawApiBaseUrl || '').trim();
if (isLocalApi) {
  if (!resolvedApiBaseUrl || resolvedApiBaseUrl.includes('api.telegram.org')) {
    resolvedApiBaseUrl = 'http://127.0.0.1:8081';
  }
} else {
  if (!resolvedApiBaseUrl) {
    resolvedApiBaseUrl = 'https://api.telegram.org';
  }
}

// Log ENV SOURCE & CONFIG immediately
logger.info(
  `[ENV SOURCE]\n` +
  `cwd=${process.cwd()}\n` +
  `env_file=${resolvedEnvPath}\n` +
  `local_api=${isLocalApi}`
);

logger.info(
  `[TELEGRAM CONFIG RAW]\n` +
  `TELEGRAM_LOCAL_API=${rawLocalApi ?? '(undefined)'}\n` +
  `TELEGRAM_API_BASE_URL=${rawApiBaseUrl ?? '(undefined)'}`
);

logger.info(
  `[TELEGRAM CONFIG RESOLVED]\n` +
  `local_api=${isLocalApi}\n` +
  `base_url=${resolvedApiBaseUrl}`
);

const { TELEGRAM_BOT_TOKEN, NODE_ENV = 'development' } = process.env;

const token = TELEGRAM_BOT_TOKEN?.trim();

if (!token) {
  logger.error(
    'TELEGRAM_BOT_TOKEN is missing in your .env file.\n' +
    'Please copy .env.example to .env and add your Telegram bot token.'
  );
  process.exit(1);
}

if (token === 'your_telegram_bot_token_here') {
  logger.error(
    'TELEGRAM_BOT_TOKEN in .env is still set to the default placeholder value ("your_telegram_bot_token_here").\n' +
    'Please replace it with your real bot token obtained from @BotFather on Telegram.'
  );
  process.exit(1);
}

export const config = {
  telegramBotToken: token,
  nodeEnv: NODE_ENV.trim(),
  isProduction: NODE_ENV.trim() === 'production',
  videoEncoder: (process.env.VIDEO_ENCODER || 'auto').trim().toLowerCase(),
  ffmpegStallTimeoutMs: Number(process.env.FFMPEG_STALL_TIMEOUT_MS) || 60000,
  ffmpegMaxDurationMs: Number(process.env.FFMPEG_MAX_DURATION_MS) || 900000,
  telegramMaxUploadMb: Number(process.env.TELEGRAM_MAX_UPLOAD_MB) || 50,
  telegramTargetMaxMb: Number(process.env.TELEGRAM_TARGET_MAX_MB) || 48,
  telegramLocalApi: isLocalApi,
  telegramLocalMaxUploadMb: Number(process.env.TELEGRAM_LOCAL_MAX_UPLOAD_MB) || 2000,
  telegramApiBaseUrl: resolvedApiBaseUrl,
  mediaConcurrency: Math.max(1, Number(process.env.MEDIA_CONCURRENCY) || 2),
  downloadConcurrency: Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY) || 3),
  gpuEncodeConcurrency: Math.max(1, Number(process.env.GPU_ENCODE_CONCURRENCY || process.env.MEDIA_CONCURRENCY) || 2),
  uploadConcurrency: Math.max(1, Number(process.env.UPLOAD_CONCURRENCY) || 3),
  maxActiveJobsPerUser: Math.max(1, Number(process.env.MAX_ACTIVE_JOBS_PER_USER) || 2),
  nvencCqLevel: Number(process.env.NVENC_CQ_LEVEL) || 19,
  nvencPreset: process.env.NVENC_PRESET || 'p4',
  x264Preset: process.env.X264_PRESET || 'veryfast',
  x264Crf: Number(process.env.X264_CRF) || 20,
  whisperModel: (process.env.WHISPER_MODEL || 'large-v3').trim(),
  whisperDevice: (process.env.WHISPER_DEVICE || 'auto').trim().toLowerCase(),
  whisperComputeType: (process.env.WHISPER_COMPUTE_TYPE || 'auto').trim().toLowerCase(),
  // 'auto' = render at highest quality matching source capabilities (no unnecessary upscaling).
  // 'maximum' = always render at 4K master regardless of source (legacy behavior).
  outputQualityMode: (['auto', 'maximum'].includes((process.env.OUTPUT_QUALITY_MODE || '').trim().toLowerCase())
    ? process.env.OUTPUT_QUALITY_MODE.trim().toLowerCase()
    : 'auto'),
  // SQUARE_FOCUS composition parameters
  // Foreground is always 100% of canvas width (spec: zero side margins, full-width 1:1 square).
  squareFocusBlur: Math.max(5, parseInt(process.env.SQUARE_FOCUS_BLUR || '30', 10)),
  squareFocusDarken: Math.min(1.0, Math.max(0.0, parseFloat(process.env.SQUARE_FOCUS_DARKEN || '0.25'))),
  squareFocusVerticalPosition: (process.env.SQUARE_FOCUS_VERTICAL_POSITION || 'center').trim().toLowerCase(),
  // Admin configuration
  adminTelegramUserId: (process.env.ADMIN_TELEGRAM_USER_ID || '').trim(),
  // Manual PRO upgrade contact configuration
  ownerTelegramUsername: (process.env.OWNER_TELEGRAM_USERNAME || '').trim().replace(/^@/, ''),
  proPriceDisplay: (process.env.PRO_PRICE_DISPLAY || '').trim(),
  proContactText: (process.env.PRO_CONTACT_TEXT || '').trim(),
  // PostgreSQL database connection string
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  // YouTube Authentication & Cookie Configuration
  youtubeAuthMode: (process.env.YOUTUBE_AUTH_MODE || 'auto').trim().toLowerCase(),
  youtubeCookiesFile: (process.env.YOUTUBE_COOKIES_FILE || '').trim(),
  youtubeBrowser: (process.env.YOUTUBE_BROWSER || process.env.YOUTUBE_COOKIES_FROM_BROWSER || '').trim().toLowerCase(),
  youtubeBrowserProfile: (process.env.YOUTUBE_BROWSER_PROFILE || '').trim(),
  youtubeCookiesContent: (process.env.YOUTUBE_COOKIES_CONTENT || process.env.YOUTUBE_COOKIES_BASE64 || '').trim(),
};

