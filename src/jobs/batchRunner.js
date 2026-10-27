import crypto from 'node:crypto';
import { Markup } from 'telegraf';
import { JobStatus } from './clipJob.js';
import { submitClipJob, releaseActiveJob } from './jobRunner.js';
import { getRemainingDailyQuota, DailyQuotaExceededError, assertAccessEnabled } from '../services/authService.js';
import { logger } from '../utils/logger.js';

// Registry of active batches by batchId
const batchesById = new Map();

export function getBatch(batchId) {
  return batchesById.get(batchId) || null;
}

/**
 * Creates and starts a multi-clip batch export for a given YouTube URL.
 *
 * @param {object} params
 * @param {string|number} params.userId
 * @param {string|number} params.chatId
 * @param {string} [params.youtubeUrl]
 * @param {string} [params.url]
 * @param {Array<object>} params.ranges
 * @param {string} [params.ratio='vertical']
 * @param {boolean} [params.captions=false]
 * @param {string|null} [params.captionStyle=null]
 * @param {import('telegraf').Telegram} params.telegram
 * @returns {Promise<object>} The created batch object
 */
export async function createAndStartBatch({
  userId,
  chatId,
  youtubeUrl,
  url,
  ranges,
  ratio = 'vertical',
  captions = false,
  captionStyle = null,
  telegram,
}) {
  const targetUrl = youtubeUrl || url;
  const batchId = `batch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const totalClips = ranges.length;

  // Upfront access and batch quota validation
  await assertAccessEnabled(userId);

  const quota = await getRemainingDailyQuota(userId);
  if (!quota.isUnlimited && quota.remaining < totalClips) {
    const errorMsg =
      `⚠️ *Daily Limit Reached*\n\n` +
      `This batch requires *${totalClips}* clips, but you only have *${quota.remaining}/${quota.limit}* clips remaining today.\n\n` +
      `Upgrade to PRO for a higher daily limit and premium features.`;
    if (telegram && chatId) {
      try {
        await telegram.sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
      } catch (sendErr) {
        logger.warn('[BatchRunner] Failed to send quota error message:', sendErr.message);
      }
    }
    throw new DailyQuotaExceededError(
      quota.usage,
      quota.limit,
      `This batch requires ${totalClips} clips, but you only have ${quota.remaining}/${quota.limit} clips remaining today.`
    );
  }

  logger.info(`[BatchRunner] Creating batch export ${batchId} for user ${userId}: ${totalClips} clips from ${targetUrl}`);

  // Initial progress message
  const initialText =
    `📦 *Exporting ${totalClips} clips...*\n\n` +
    `✅ 0/${totalClips} complete\n` +
    `⚙️ 1/${totalClips} processing\n` +
    `⏳ ${Math.max(0, totalClips - 1)}/${totalClips} waiting`;

  const cancelKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel batch', `batch_cancel_${batchId}`)],
  ]);

  let progressMessage = null;
  try {
    progressMessage = await telegram.sendMessage(chatId, initialText, {
      parse_mode: 'Markdown',
      ...cancelKeyboard,
    });
  } catch (err) {
    logger.error(`[BatchRunner] Failed to send initial batch progress message:`, err);
  }

  const batch = {
    batchId,
    userId: String(userId),
    chatId,
    youtubeUrl: targetUrl,
    totalClips,
    ratio,
    captions,
    captionStyle,
    progressMessageId: progressMessage?.message_id || null,
    telegram,
    isCancelled: false,
    createdAt: Date.now(),
    completedAt: null,
    clips: ranges.map((r, i) => ({
      index: i + 1,
      start: r.start,
      end: r.end,
      duration: r.duration,
      ratio,
      captions,
    })),
    jobs: [],
  };

  batchesById.set(batchId, batch);

  // Submit each clip job to the existing scheduler pools
  for (let i = 0; i < ranges.length; i++) {
    if (batch.isCancelled) break;

    const r = ranges[i];
    const job = submitClipJob({
      telegram,
      jobData: {
        jobId: `${batchId}-${i + 1}`,
        userId,
        chatId,
        url: targetUrl,
        startTime: r.start,
        endTime: r.end,
        ratio,
        captions,
        captionStyle,
        batchId,
        batchIndex: i + 1,
        totalBatchClips: totalClips,
        batchProgressMessageId: batch.progressMessageId,
      },
    });

    batch.jobs.push(job);
  }

  return batch;
}

/**
 * Updates the live batch progress message in Telegram.
 *
 * @param {string} batchId
 */
export async function updateBatchProgress(batchId) {
  const batch = batchesById.get(batchId);
  if (!batch || !batch.progressMessageId) return;

  const total = batch.totalClips;
  let completed = 0;
  let failed = 0;
  let processing = 0;
  let queued = 0;

  for (const j of batch.jobs) {
    if (j.status === JobStatus.COMPLETED) completed++;
    else if (j.status === JobStatus.FAILED || j.status === JobStatus.CANCELLED) failed++;
    else if (j.status === JobStatus.DOWNLOADING || j.status === JobStatus.PROCESSING || j.status === JobStatus.UPLOADING) processing++;
    else queued++;
  }

  const isFinished = (completed + failed) === total;

  let text;
  let extra = { parse_mode: 'Markdown' };

  if (batch.isCancelled) {
    text = `❌ *Batch cancelled* (${completed}/${total} clips delivered).`;
  } else if (isFinished) {
    batch.completedAt = Date.now();
    text =
      `✅ *All ${completed}/${total} clips exported successfully!*\n\n` +
      `Each clip was delivered above. Send /clip anytime for a new video!`;
  } else {
    text =
      `📦 *Exporting ${total} clips...*\n\n` +
      `✅ ${completed}/${total} complete\n` +
      `⚙️ ${processing}/${total} processing\n` +
      `⏳ ${queued}/${total} waiting`;

    extra = {
      ...extra,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel batch', `batch_cancel_${batchId}`)],
      ]),
    };
  }

  try {
    await batch.telegram.editMessageText(batch.chatId, batch.progressMessageId, undefined, text, extra);
  } catch (err) {
    if (!err.message?.includes('message is not modified')) {
      logger.debug(`[BatchRunner] Could not update batch progress message: ${err.message}`);
    }
  }

  if (isFinished || batch.isCancelled) {
    // Keep in registry for 10 minutes then clean up
    const timer = setTimeout(() => {
      batchesById.delete(batchId);
    }, 10 * 60 * 1000);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

/**
 * Cancels an ongoing batch of clips cleanly.
 *
 * @param {string} batchId
 * @returns {Promise<boolean>}
 */
export async function cancelBatch(batchId) {
  const batch = batchesById.get(batchId);
  if (!batch) return false;

  logger.info(`[BatchRunner] Cancelling batch ${batchId} for user ${batch.userId}`);
  batch.isCancelled = true;

  for (const job of batch.jobs) {
    if (job.status === JobStatus.QUEUED || job.status === JobStatus.DOWNLOADING || job.status === JobStatus.PROCESSING) {
      job.status = JobStatus.CANCELLED;
      job.completedAt = Date.now();
      releaseActiveJob(job);
    }
  }

  await updateBatchProgress(batchId);
  return true;
}
