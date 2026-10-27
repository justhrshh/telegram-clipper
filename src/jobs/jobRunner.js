import { Markup } from 'telegraf';
import { ClipJob, JobStatus } from './clipJob.js';
import { processClipJob } from '../services/clipService.js';
import { getVideoFormat } from '../config/formats.js';
import { PipelineStage, PipelineError } from '../utils/errors.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { scheduler } from './scheduler.js';
import { setUserLastUrl } from '../session/sessionStore.js';
import { updateBatchProgress } from './batchRunner.js';
import { assertFeatureAccess, assertAccessEnabled, FEATURE_SQUARE_FOCUS } from '../services/authService.js';
import { reserveAndCreateClipRequest, updateClipRequestStatus } from '../db/clipRequestRepository.js';
import { incrementUserCounter } from '../db/userRepository.js';
import { parseTimestampToSeconds } from '../utils/validator.js';

// In-memory registries
const jobsById = new Map();

/**
 * Registers an active job for a user in the in-memory registry and scheduler.
 *
 * @param {ClipJob} job
 */
export function registerActiveJob(job) {
  const uid = String(job.userId);
  jobsById.set(job.jobId, job);
  scheduler.registerUserJob(uid, job.jobId);
}

/**
 * Releases the active job lock for a user.
 *
 * @param {ClipJob|string|number} jobOrUserId
 * @param {string} [maybeJobId]
 */
export function releaseActiveJob(jobOrUserId, maybeJobId) {
  let uid;
  let jid;
  if (typeof jobOrUserId === 'object' && jobOrUserId !== null) {
    uid = String(jobOrUserId.userId);
    jid = jobOrUserId.jobId;
  } else {
    uid = String(jobOrUserId);
    jid = maybeJobId;
  }
  if (jid) {
    scheduler.unregisterUserJob(uid, jid);
  }
}

/**
 * Checks whether a user currently has the maximum allowed active processing jobs.
 *
 * @param {string|number} userId
 * @returns {boolean}
 */
export function isUserBusy(userId) {
  const uid = String(userId);
  const activeCount = scheduler.getUserActiveCount(uid);
  return activeCount >= (config.maxActiveJobsPerUser || 2);
}

/**
 * Retrieves the currently active job for a user, if any.
 *
 * @param {string|number} userId
 * @returns {ClipJob|null}
 */
export function getActiveJobForUser(userId) {
  const uid = String(userId);
  for (const job of jobsById.values()) {
    if (job.userId === uid && job.status !== JobStatus.COMPLETED && job.status !== JobStatus.FAILED) {
      return job;
    }
  }
  return null;
}

/**
 * Submits a new clip job to run in the background.
 *
 * The caller does NOT await the job's completion; this returns immediately after registration.
 * Decoupled ResourceScheduler handles stage concurrency (download, GPU encode, upload) independently.
 *
 * @param {object} params
 * @param {import('telegraf').Telegram} params.telegram - Telegraf Telegram API client
 * @param {object} params.jobData - Job parameters
 * @returns {ClipJob} The submitted job
 */
export function submitClipJob({ telegram, jobData }) {
  const job = new ClipJob(jobData);
  registerActiveJob(job);

  logger.info(
    `[${job.jobId}] [JOB_SUBMITTED] User: ${job.userId} | Chat: ${job.chatId} | ` +
    `URL: ${job.url} [${job.startTime} -> ${job.endTime}] | Format: ${job.ratio}`
  );

  // Background execution with decoupled resource scheduler
  executeJob(job, telegram).catch((unhandledError) => {
    logger.error(`[${job.jobId}] [CRITICAL_JOB_RUNNER_ERROR] Uncaught job error:`, unhandledError);
    job.status = JobStatus.FAILED;
    job.completedAt = Date.now();
    releaseActiveJob(job);
  });

  return job;
}


/**
 * Safely updates a status message in Telegram without throwing or aborting the job on failure.
 *
 * @param {import('telegraf').Telegram} telegram
 * @param {ClipJob} job
 * @param {string} text
 * @param {object} [extra]
 */
async function safeUpdateStatus(telegram, job, text, extra = {}) {
  if (!job.statusMessageId) return;
  try {
    await telegram.editMessageText(job.chatId, job.statusMessageId, undefined, text, extra);
  } catch (err) {
    // Ignore "message is not modified"
    if (err.message?.includes('message is not modified')) return;

    logger.debug(`[${job.jobId}] Status update skipped (retrying plain text if needed): ${err.message}`);
    // If Markdown parsing failed, attempt sending plain text
    if (extra.parse_mode === 'Markdown') {
      try {
        const plainText = text.replace(/[*_`]/g, '');
        await telegram.editMessageText(job.chatId, job.statusMessageId, undefined, plainText);
      } catch {}
    }
  }
}

/**
 * Executes the complete clip pipeline in the background.
 *
 * @param {ClipJob} job
 * @param {import('telegraf').Telegram} telegram
 */
async function executeJob(job, telegram) {
  job.status = JobStatus.PROCESSING;
  const formatObj = getVideoFormat(job.ratio || 'vertical');
  const formatLabel = `${formatObj.icon} ${formatObj.label}`;

  const updateStatus = async (messageText) => {
    await safeUpdateStatus(telegram, job, messageText);
  };

  let result = null;
  let quotaResult = null;

  try {
    // Backend access and feature gate enforcement
    await assertAccessEnabled(job.userId);
    if (job.presentation === 'square_focus') {
      await assertFeatureAccess({ userId: job.userId, feature: FEATURE_SQUARE_FOCUS });
    }

    // Normalize timestamps to integer seconds
    const startSec = parseTimestampToSeconds(job.startTime) ?? job.startSeconds ?? 0;
    const endSec = parseTimestampToSeconds(job.endTime) ?? job.endSeconds ?? 0;
    const requestedDurationSec = Math.max(0, endSec - startSec);

    // Atomically verify quota with PostgreSQL row lock & insert clip request
    quotaResult = await reserveAndCreateClipRequest({
      telegramUserId: job.userId,
      youtubeUrl: job.url,
      startSeconds: startSec,
      endSeconds: endSec,
      duration: requestedDurationSec,
      format: job.ratio,
      presentationStyle: job.presentation,
      captions: job.captions,
      status: 'PROCESSING',
      jobId: job.jobId,
    });

    if (!quotaResult.allowed) {
      if (quotaResult.reason === 'ACCESS_DISABLED') {
        throw new PipelineError({
          stage: PipelineStage.VALIDATION_FAILED,
          message: 'Your access to the clipper bot has been disabled by an administrator.',
          jobId: job.jobId,
        });
      }
      throw new PipelineError({
        stage: PipelineStage.VALIDATION_FAILED,
        message: `Daily limit reached (${quotaResult.usageToday}/${quotaResult.limit} clips). Upgrade to PRO for higher daily limits and premium features.`,
        jobId: job.jobId,
      });
    }

    incrementUserCounter(job.userId, 'total_clips').catch(() => {});

    result = await processClipJob(
      {
        url: job.url,
        startTime: job.startTime,
        endTime: job.endTime,
        ratio: job.ratio || 'vertical',
        presentation: job.presentation || 'standard',
        captions: Boolean(job.captions),
        captionStyle: job.captionStyle || null,
        captionConfig: job.captionConfig || null,
        userId: job.userId,
        jobId: job.jobId,
      },
      async (stage, message) => {
        job.currentStage = stage;
        await updateStatus(message);
        if (job.batchId) {
          updateBatchProgress(job.batchId).catch(() => {});
        }
      }
    );

    job.status = JobStatus.UPLOADING;
    job.currentStage = 'UPLOADING';
    await updateStatus('📤 Delivering clip to Telegram...');

    const durationSec = Math.round(result.duration);
    const delivery = result.delivery;
    const sourceAware = result.sourceAware || {};
    const encoderLabel = result.encoder === 'h264_nvenc' ? '⚡ NVIDIA NVENC (GPU)' : result.encoder === 'stream_copy' ? '⚡ Stream Copy (Lossless)' : '🖥️ libx264 (Fast CPU)';
    const effectiveMaxMb = config.telegramLocalApi
      ? (config.telegramLocalMaxUploadMb || 2000)
      : (config.telegramMaxUploadMb || 50);
    const maxUploadBytes = effectiveMaxMb * 1024 * 1024;

    // Guard: Check against configured max upload limit
    if (delivery.bytes > maxUploadBytes) {
      logger.warn(
        `[${job.jobId}] Delivered file size (${delivery.fileSizeMB} MB) still exceeds Telegram limit (${effectiveMaxMb} MB).`
      );

      const limitExceededMessage =
        `⚠️ *Telegram Upload Limit Reached*\n\n` +
        `The clip was rendered at high quality, but its file size is *${delivery.fileSizeMB} MB*.\n\n` +
        `Telegram limits bot uploads to *${effectiveMaxMb} MB* per file.\n\n` +
        `*Clip Specs:*\n` +
        `• *Format:* ${formatLabel}\n` +
        `• *Resolution:* ${delivery.width}×${delivery.height} @ ${delivery.fps} FPS\n` +
        `• *Delivery Tier:* ${delivery.tierName}\n` +
        `• *Encoder:* ${encoderLabel}\n` +
        `• *Duration:* ${durationSec}s\n` +
        `• *Size:* ${delivery.fileSizeMB} MB\n\n` +
        `💡 *Tip:* Try selecting a shorter duration to stay under the limit.`;

      await safeUpdateStatus(telegram, job, limitExceededMessage, { parse_mode: 'Markdown' });
      job.status = JobStatus.COMPLETED;
      job.completedAt = Date.now();
      return;
    }

    const resText = `${delivery.width}×${delivery.height} @ ${delivery.fps} FPS`;
    let sourceNote = '';
    const sc = result.sourceClassification || result.sourceAware || {};
    if (sc.sourceClass && sc.masterWidth) {
      const isUpscaled = sc.masterClass === 'upscaled';
      const modeLabel = sc.sourceClass === 'native-4k' ? '4K native' : `${sc.sourceClass} ${isUpscaled ? 'upscaled to ' + sc.masterWidth + '×' + sc.masterHeight : 'native'}`;
      sourceNote = `\n🔍 *Source:* ${sc.masterWidth && sc.masterHeight ? `${(result.sourceAware?.sourceWidth || sc.masterWidth)}×${(result.sourceAware?.sourceHeight || sc.masterHeight)} → rendered at ${sc.masterWidth}×${sc.masterHeight} (${modeLabel})` : ''}`;
    } else if (sourceAware.masterIsUpscaled) {
      sourceNote = `\n🔍 *Source:* ${sourceAware.sourceWidth}×${sourceAware.sourceHeight} → upscaled master`;
    } else if (sourceAware.sourceWidth) {
      sourceNote = `\n🔍 *Source:* ${sourceAware.sourceWidth}×${sourceAware.sourceHeight} @ ${sourceAware.sourceFps} FPS`;
    }

    const usageLine = quotaResult
      ? (quotaResult.limit === Infinity
          ? '\n📊 *Usage:* Unlimited'
          : `\n📊 *Usage:* ${quotaResult.usageToday} / ${quotaResult.limit} clips today`)
      : '';

    const captionText =
      '✅ *Clip ready*\n\n' +
      `📐 *Format:* ${formatLabel}\n` +
      `📺 *Resolution:* ${resText}\n` +
      `📦 *Tier:* ${delivery.tierName}\n` +
      `💾 *Size:* ${delivery.fileSizeMB} MB\n` +
      `⏱️ *Duration:* ${durationSec}s\n` +
      `⚙️ *Rendered with:* ${encoderLabel}` +
      sourceNote +
      usageLine +
      '\n\nSend /clip anytime to create another clip!';

    const T0 = job.startedAt || Date.now();
    const T1 = result.stageTimings?.DOWNLOAD?.start || T0;
    const T2 = result.stageTimings?.DOWNLOAD?.start || T0;
    const T3 = result.stageTimings?.DOWNLOAD?.end || T2;
    const T4 = result.stageTimings?.VIDEO_RENDER?.start || T3;
    const T5 = result.stageTimings?.VIDEO_RENDER?.end || T4;

    const tUploadStart = Date.now();
    const T6 = tUploadStart;
    let uploadDurationMs = 0;

    const activeApiRoot = telegram.options?.apiRoot || config.telegramApiBaseUrl;
    const sendMode = config.telegramLocalApi ? 'LOCAL' : 'HOSTED';

    logger.info(
      `[TELEGRAM SEND]\n` +
      `mode=${sendMode}\n` +
      `base_url=${activeApiRoot}\n` +
      `file_size=${delivery.fileSizeMB}MB`
    );

    if (config.telegramLocalApi && activeApiRoot.includes('api.telegram.org')) {
      throw new PipelineError({
        stage: PipelineStage.TELEGRAM_UPLOAD_FAILED,
        message: `LOCAL_API_ENDPOINT_MISMATCH: Local API mode is enabled (TELEGRAM_LOCAL_API=true) but Telegraf base_url resolved to hosted Telegram API (${activeApiRoot}). Refusing to upload.`,
        jobId: job.jobId,
      });
    }

    logger.info(
      `[UPLOAD]\n` +
      `method=filesystem\n` +
      `memory_buffer=false\n` +
      `file_size=${delivery.bytes}\n` +
      `file_path=${delivery.deliveredPath}`
    );

    const releaseUpload = await scheduler.acquireUploadSlot(
      job.jobId,
      job.userId,
      (pos) => updateStatus(`⏳ Queued for upload (position #${pos})...`)
    );

    try {
      // In Telegraf, passing { source: filePath } creates a streaming ReadStream directly from disk.
      // Zero full-file Buffer, zero base64, zero loading hundreds of MB into Node memory.
      const videoPayload = { source: delivery.deliveredPath };

      const isBatch = Boolean(job.batchId);
      const multiButtonText = isBatch ? '📦 More clips from this video' : '📦 Export multiple clips';

      const postExportKeyboard = {
        inline_keyboard: [
          [
            { text: '🎬 Create another clip', callback_data: 'reclip_single' },
            { text: multiButtonText, callback_data: 'reclip_batch' },
          ],
        ],
      };

      await telegram.sendVideo(
        job.chatId,
        videoPayload,
        {
          caption: captionText,
          parse_mode: 'Markdown',
          width: delivery.width,
          height: delivery.height,
          supports_streaming: true,
          reply_markup: postExportKeyboard,
        }
      );

      // Record latest successfully processed URL for instant re-clip
      setUserLastUrl(job.userId, job.url);

      const tUploadEnd = Date.now();
      const T7 = tUploadEnd;
      uploadDurationMs = tUploadEnd - tUploadStart;
      const uploadDurationSec = (uploadDurationMs / 1000).toFixed(2);
      const uploadSpeedMBps = uploadDurationMs > 0
        ? ((delivery.bytes / (1024 * 1024)) / (uploadDurationMs / 1000)).toFixed(2)
        : '0.00';

      logger.info(
        `[${job.jobId}] [STAGE_TIMING] UPLOAD: ${uploadDurationSec}s (${uploadDurationMs}ms, ${uploadSpeedMBps} MB/s) | ` +
        `Clip delivered successfully to user ${job.userId} (${delivery.tierName} | ${delivery.fileSizeMB} MB)`
      );

      // Delete status message if present
      if (job.statusMessageId) {
        try {
          await telegram.deleteMessage(job.chatId, job.statusMessageId);
        } catch {}
      }
    } catch (uploadError) {
      logger.error(`[${job.jobId}] Telegram video upload failed:`, uploadError);
      throw new PipelineError({
        stage: PipelineStage.TELEGRAM_UPLOAD_FAILED,
        message: `Telegram video delivery failed: ${uploadError.message}`,
        jobId: job.jobId,
        cause: uploadError,
      });
    } finally {
      releaseUpload();
    }

    const T8 = Date.now();
    job.status = JobStatus.COMPLETED;
    job.completedAt = T8;
    job.result = result;

    updateClipRequestStatus(job.jobId, { status: 'COMPLETED', completedAt: T8 }).catch(() => {});
    incrementUserCounter(job.userId, 'successful_clips').catch(() => {});

    const totalElapsedMs = T8 - T0;
    const totalElapsedSec = (totalElapsedMs / 1000).toFixed(2);
    const timings = result.stageTimings || {};
    const uploadDurationSec = (uploadDurationMs / 1000).toFixed(2);
    const uploadSpeedMBps = uploadDurationMs > 0
      ? ((delivery.bytes / (1024 * 1024)) / (uploadDurationMs / 1000)).toFixed(2)
      : '0.00';

    const metaSec = Math.max(0, (T1 - T0) / 1000).toFixed(2);
    const downSec = Math.max(0, (T3 - T2) / 1000).toFixed(2);
    const procSec = Math.max(0, (T5 - T4) / 1000).toFixed(2);
    const upSec = uploadDurationSec;

    logger.info(
      `\n================================\n` +
      `[TIMING]\n` +
      `metadata=${metaSec}s (${Math.max(0, T1 - T0)}ms)\n` +
      `download=${downSec}s (${Math.max(0, T3 - T2)}ms)\n` +
      `process=${procSec}s (${Math.max(0, T5 - T4)}ms)\n` +
      `upload=${upSec}s (${uploadDurationMs}ms)\n` +
      `total=${totalElapsedSec}s (${totalElapsedMs}ms)\n` +
      `================================`
    );

    // Performance failsafe: if total processing exceeds 300s, identify slowest stage
    if (Number(totalElapsedSec) > 300) {
      const stageDurations = {
        metadata: Number(metaSec),
        download: Number(downSec),
        process: Number(procSec),
        upload: Number(upSec),
      };
      let slowestStage = 'download';
      let maxStageTime = 0;
      for (const [stg, tm] of Object.entries(stageDurations)) {
        if (tm > maxStageTime) {
          maxStageTime = tm;
          slowestStage = stg;
        }
      }
      logger.warn(
        `\n[PERFORMANCE WARNING]\n` +
        `slowest_stage=${slowestStage}\n` +
        `elapsed=${maxStageTime}s\n`
      );
    }

    logger.info(
      `\n================================\n` +
      `[PERFORMANCE]\n` +
      `jobId=${job.jobId}\n` +
      `total_time=${totalElapsedSec}s\n` +
      `download_time=${downSec}s\n` +
      `render_time=${procSec}s\n` +
      `upload_time=${uploadDurationSec}s\n` +
      `upload_speed=${uploadSpeedMBps} MB/s\n` +
      `tier=${delivery.tierName}\n` +
      `size=${delivery.fileSizeMB} MB\n` +
      `================================`
    );

    logger.info(
      `[${job.jobId}] [END_TO_END_BENCHMARK_COMPLETE]\n` +
      `  DOWNLOAD:           ${downSec}s\n` +
      `  VIDEO_RENDER:       ${procSec}s (${result.encoder})\n` +
      `  DELIVERY_PLAN:      ${timings.DELIVERY_PLAN?.durationSec || '0.0'}s\n` +
      `  UPLOAD:             ${uploadDurationSec}s (${uploadSpeedMBps} MB/s)\n` +
      `  TOTAL JOB TIME:     ${totalElapsedSec}s\n` +
      `  Output Specs:       ${result.metadata.width}x${result.metadata.height} @ ${result.metadata.fps}fps (${result.metadata.fileSizeMB} MB)`
    );
  } catch (error) {
    job.status = JobStatus.FAILED;
    job.completedAt = Date.now();
    job.error = error;

    updateClipRequestStatus(job.jobId, {
      status: 'FAILED',
      completedAt: job.completedAt,
      errorMessage: error.message,
    }).catch(() => {});
    incrementUserCounter(job.userId, 'failed_clips').catch(() => {});

    const stage = error instanceof PipelineError ? error.stage : (job.currentStage || 'UNKNOWN');

    const totalElapsedSec = ((job.completedAt - job.startedAt) / 1000).toFixed(1);
    logger.error(
      `[${job.jobId}] [JOB_FAILED] User: ${job.userId} | Stage: [${stage}] | Elapsed: ${totalElapsedSec}s:\n` +
      `  Build:     ${TELEGRAM_CLIPPER_BUILD} (PID: ${process.pid})\n` +
      `  Message:   ${error.message}\n` +
      `  Exit Code: ${error.exitCode ?? 'N/A'}\n` +
      `  Signal:    ${error.signal ?? 'N/A'}\n` +
      `  Stderr:    ${error.stderr || '(empty)'}\n` +
      `  Stdout:    ${error.stdout || '(empty)'}\n` +
      `  Stack:     ${error.stack}`
    );

    // Stage-specific friendly user message
    let friendlyHeader = '❌ *Clip Processing Error*';
    let friendlyDetail = 'An issue occurred while processing your clip.';

    if (error.code === 'ACCESS_DENIED') {
      friendlyHeader = '🚫 *Access Disabled*';
      friendlyDetail = 'Your access to the clipper bot has been disabled by an administrator.';
    } else if (error.code === 'FEATURE_LOCKED') {
      friendlyHeader = '🔒 *Square Focus is a PRO Feature*';
      friendlyDetail = 'Upgrade to Pro to unlock premium 1:1 cinematic exports.';
    } else if (error.code === 'DAILY_QUOTA_EXCEEDED' || error.message?.includes('Daily limit reached')) {
      friendlyHeader = '⚠️ *Daily Limit Reached*';
      friendlyDetail = error.message;
    } else {
      switch (stage) {
      case PipelineStage.DOWNLOAD_FAILED:
        if (error.code === 'BOT_VERIFICATION_REQUIRED') {
          friendlyHeader = '🛡️ *YouTube Verification Required*';
          friendlyDetail =
            'YouTube is temporarily requiring verification (bot protection) to access this video.\n\n' +
            '• The administrator can configure authentication cookies to resolve this.\n' +
            '• You can also try again in a few minutes or with another video.';
        } else if (error.code === 'AGE_RESTRICTED') {
          friendlyHeader = '🔞 *Age-Restricted Video*';
          friendlyDetail =
            'This video is age-restricted on YouTube and requires authentication to download.\n\n' +
            '• The administrator can configure cookies to enable access to age-restricted videos.';
        } else if (error.code === 'GEO_RESTRICTED') {
          friendlyHeader = '🌍 *Region-Locked Video*';
          friendlyDetail =
            'This video has been restricted by the creator and is unavailable in the bot server\'s region.';
        } else if (error.code === 'PRIVATE_OR_UNAVAILABLE') {
          friendlyHeader = '🔒 *Video Unavailable*';
          friendlyDetail =
            'This YouTube video is private, deleted, premiering soon, or unavailable.\n\n' +
            '• Please verify that the link is correct and publicly viewable.';
        } else if (error.code === 'DOWNLOAD_STALLED') {
          friendlyHeader = '⏳ *Download Stalled*';
          friendlyDetail =
            'The YouTube download connection stalled or timed out before completion.\n\n' +
            '• Please try again in a few moments.';
        } else {
          friendlyHeader = '❌ *Video Download Failed*';
          friendlyDetail =
            'We couldn\'t download the requested video from YouTube.\n\n' +
            '• Please verify that the YouTube link is public and accessible.\n' +
            '• Age-restricted or region-locked videos cannot be downloaded.';
        }
        break;

      case PipelineStage.CLIP_FAILED: {
        friendlyHeader = '❌ *Video Processing Failed*';
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('timestamp') || msg.includes('duration') || msg.includes('greater than start')) {
          friendlyDetail =
            'Unable to clip the video at the requested timestamps.\n\n' +
            '• Please make sure your start and end timestamps fall within the video duration.';
        } else {
          friendlyDetail =
            'We encountered an issue while processing and formatting your clip.\n\n' +
            '• Please try again in a moment or try selecting a slightly shorter clip duration.';
        }
        break;
      }

      case PipelineStage.TRANSCRIPTION_FAILED:
        friendlyHeader = '❌ *Speech Transcription Failed*';
        friendlyDetail =
          'AI transcription was unable to process the speech in this clip.\n\n' +
          '💡 You can still create this clip without captions by choosing *NO* at the captions prompt.';
        break;

      case PipelineStage.CAPTION_RENDER_FAILED:
        friendlyHeader = '❌ *Caption Rendering Failed*';
        friendlyDetail = 'Unable to burn kinetic captions onto the vertical short.';
        break;

      case PipelineStage.TELEGRAM_UPLOAD_FAILED:
        friendlyHeader = '❌ *Telegram Delivery Failed*';
        friendlyDetail =
          'The 4K vertical clip was rendered successfully, but Telegram was unable to deliver the video file.\n' +
          '(Network connection was interrupted or Telegram API timed out).';
        break;
      }
    }

    const isPolicyError =
      error.code === 'ACCESS_DENIED' ||
      error.code === 'FEATURE_LOCKED' ||
      error.code === 'DAILY_QUOTA_EXCEEDED' ||
      error.message?.includes('Daily limit reached');

    logger.error(
      `[${job.jobId}] Clip processing failed at stage ${stage}: ${error.message} ` +
      `[ExitCode: ${error.exitCode ?? 'N/A'}] [PID: ${process.pid}]`,
      {
        jobId: job.jobId,
        userId: job.userId,
        stage,
        exitCode: error.exitCode,
        stderr: error.stderr,
        stack: error.stack,
      }
    );

    let failureMessage;
    let keyboard;

    if (isPolicyError) {
      failureMessage = `${friendlyHeader}\n\n${friendlyDetail}`;
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade to PRO', 'upgrade_pro_screen')],
      ]);
    } else {
      failureMessage = `${friendlyHeader}\n\n${friendlyDetail}`;
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔁 Try Again', 'start_create_clip')],
      ]);
    }

    // Safely deliver failure message
    try {
      const extra = {
        parse_mode: 'Markdown',
        ...keyboard,
      };
      if (job.statusMessageId) {
        await safeUpdateStatus(telegram, job, failureMessage, extra);
      } else {
        await telegram.sendMessage(job.chatId, failureMessage, extra);
      }
    } catch (notifyErr) {
      logger.error(`[${job.jobId}] Failed to deliver failure message to chat ${job.chatId}:`, notifyErr);
    }
  } finally {
    if (result && typeof result.cleanup === 'function') {
      try {
        await result.cleanup();
      } catch (cleanupErr) {
        logger.warn(`[${job.jobId}] Cleanup warning:`, cleanupErr.message);
      }
    }
    if (job.status !== JobStatus.COMPLETED && job.status !== JobStatus.FAILED) {
      job.status = JobStatus.FAILED;
    }
    job.completedAt = job.completedAt || Date.now();
    releaseActiveJob(job);
    if (job.batchId) {
      updateBatchProgress(job.batchId).catch(() => {});
    }
  }
}
