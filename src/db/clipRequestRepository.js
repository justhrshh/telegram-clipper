/**
 * Clip Request Repository
 *
 * Persists clip job metadata, timestamps, configuration parameters, and status transitions.
 * Provides concurrency-safe quota reservation and daily usage tracking.
 */

import { query, withTransaction } from './pool.js';
import { isConfiguredOwner } from './userRepository.js';
import { getPlanLimits } from '../config/planLimits.js';
import { extractYouTubeVideoId, canonicalizeYouTubeUrl, parseTimestampToSeconds } from '../utils/validator.js';
import { logger } from '../utils/logger.js';

export const ClipStatus = {
  REQUESTED: 'REQUESTED',
  QUEUED: 'QUEUED',
  DOWNLOADING: 'DOWNLOADING',
  PROCESSING: 'PROCESSING',
  UPLOADING: 'UPLOADING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/**
 * Returns the count of clip requests started today that count against daily quota.
 * Excludes cancelled clips.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<number>}
 */
export async function getDailyUsageCount(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT COUNT(*) AS count
    FROM clip_requests
    WHERE telegram_user_id = $1
      AND requested_at >= CURRENT_DATE
      AND status != 'CANCELLED';
  `;
  const res = await query(sql, [uid]);
  return parseInt(res.rows[0]?.count || 0, 10);
}

/**
 * Inserts a new clip request record directly.
 *
 * @param {object} params
 * @param {string|number} params.telegramUserId
 * @param {string} params.youtubeUrl
 * @param {number} [params.startSeconds]
 * @param {number} [params.endSeconds]
 * @param {number} [params.duration]
 * @param {string} [params.format]
 * @param {string} [params.presentationStyle]
 * @param {string|boolean} [params.captions]
 * @param {string} [params.status='REQUESTED']
 * @param {string} params.jobId
 * @returns {Promise<object>}
 */
export async function createClipRequest({
  telegramUserId,
  youtubeUrl,
  startSeconds,
  endSeconds,
  duration,
  format,
  presentationStyle,
  captions,
  status = ClipStatus.REQUESTED,
  jobId,
}) {
  const uid = String(telegramUserId);
  const canonicalUrl = canonicalizeYouTubeUrl(youtubeUrl);
  const videoId = extractYouTubeVideoId(youtubeUrl);

  const sql = `
    INSERT INTO clip_requests (
      telegram_user_id, youtube_url, canonical_url, video_id, start_seconds, end_seconds, duration,
      format, presentation_style, captions, status, job_id, requested_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING *;
  `;

  const cleanStartSec = parseTimestampToSeconds(startSeconds) ?? (typeof startSeconds === 'number' && Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0);
  const cleanEndSec = parseTimestampToSeconds(endSeconds) ?? (typeof endSeconds === 'number' && Number.isFinite(endSeconds) ? Math.max(0, endSeconds) : 0);
  const cleanDuration = (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0)
    ? duration
    : (parseTimestampToSeconds(duration) ?? Math.max(0, cleanEndSec - cleanStartSec));

  const captionsStr = typeof captions === 'boolean' ? (captions ? 'YES' : 'NO') : String(captions || 'NO');

  const res = await query(sql, [
    uid,
    youtubeUrl,
    canonicalUrl,
    videoId,
    cleanStartSec,
    cleanEndSec,
    cleanDuration,
    format || 'vertical',
    presentationStyle || 'standard',
    captionsStr,
    status,
    jobId,
  ]);

  return res.rows[0];
}

/**
 * Transactionally verifies quota and creates a clip request record.
 * Uses row-level locking (SELECT ... FOR UPDATE) on the user row to ensure
 * two simultaneous requests near the quota boundary cannot both succeed.
 *
 * OWNER and ADMIN bypass quota limits completely.
 *
 * @param {object} params
 * @param {string|number} params.telegramUserId
 * @param {string} params.youtubeUrl
 * @param {number} [params.startSeconds]
 * @param {number} [params.endSeconds]
 * @param {number} [params.duration]
 * @param {string} [params.format]
 * @param {string} [params.presentationStyle]
 * @param {string|boolean} [params.captions]
 * @param {string} [params.status='PROCESSING']
 * @param {string} params.jobId
 * @param {number} [params.requiredQuota=1]
 * @returns {Promise<{ allowed: boolean, record?: object, usageToday: number, limit: number, remaining: number, plan: string, reason?: string }>}
 */
export async function reserveAndCreateClipRequest({
  telegramUserId,
  youtubeUrl,
  startSeconds,
  endSeconds,
  duration,
  format,
  presentationStyle,
  captions,
  status = ClipStatus.PROCESSING,
  jobId,
  requiredQuota = 1,
}) {
  const uid = String(telegramUserId);
  const isOwnerUser = isConfiguredOwner(uid);

  return await withTransaction(async (client) => {
    // 1. Lock user row to serialize concurrent requests for this user
    const userRes = await client.query(
      'SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE;',
      [uid]
    );
    const user = userRes.rows[0];

    const role = isOwnerUser ? 'OWNER' : (user?.role || 'USER');
    const isFullAccess = role === 'OWNER' || role === 'ADMIN';

    if (user && !user.access_enabled && !isFullAccess) {
      return {
        allowed: false,
        reason: 'ACCESS_DISABLED',
        remaining: 0,
        limit: 0,
        usageToday: 0,
        plan: user?.plan || 'FREE',
      };
    }

    let limit = Infinity;
    let usageToday = 0;
    let remaining = Infinity;
    const userPlan = isFullAccess ? role : (user?.plan || 'FREE');

    if (!isFullAccess) {
      const limits = getPlanLimits(role, userPlan);
      limit = limits.dailyClips;

      const usageRes = await client.query(
        `SELECT COUNT(*) AS count
         FROM clip_requests
         WHERE telegram_user_id = $1
           AND requested_at >= CURRENT_DATE
           AND status != 'CANCELLED';`,
        [uid]
      );
      usageToday = parseInt(usageRes.rows[0]?.count || 0, 10);
      remaining = Math.max(0, limit - usageToday);

      if (usageToday + requiredQuota > limit) {
        return {
          allowed: false,
          reason: 'QUOTA_EXCEEDED',
          usageToday,
          limit,
          remaining,
          plan: userPlan,
        };
      }
    }

    // 2. Insert clip request record inside the transaction
    const canonicalUrl = canonicalizeYouTubeUrl(youtubeUrl);
    const videoId = extractYouTubeVideoId(youtubeUrl);
    const cleanStartSec = parseTimestampToSeconds(startSeconds) ?? (typeof startSeconds === 'number' && Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0);
    const cleanEndSec = parseTimestampToSeconds(endSeconds) ?? (typeof endSeconds === 'number' && Number.isFinite(endSeconds) ? Math.max(0, endSeconds) : 0);
    const cleanDuration = (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0)
      ? duration
      : (parseTimestampToSeconds(duration) ?? Math.max(0, cleanEndSec - cleanStartSec));

    const captionsStr = typeof captions === 'boolean' ? (captions ? 'YES' : 'NO') : String(captions || 'NO');
    const insertSql = `
      INSERT INTO clip_requests (
        telegram_user_id, youtube_url, canonical_url, video_id, start_seconds, end_seconds, duration,
        format, presentation_style, captions, status, job_id, requested_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      RETURNING *;
    `;

    const insertRes = await client.query(insertSql, [
      uid,
      youtubeUrl,
      canonicalUrl,
      videoId,
      cleanStartSec,
      cleanEndSec,
      cleanDuration,
      format || 'vertical',
      presentationStyle || 'standard',
      captionsStr,
      status,
      jobId,
    ]);

    const newRemaining = isFullAccess ? Infinity : Math.max(0, remaining - requiredQuota);
    return {
      allowed: true,
      record: insertRes.rows[0],
      usageToday: usageToday + requiredQuota,
      limit,
      remaining: newRemaining,
      plan: userPlan,
    };
  });
}

/**
 * Updates status, completion timestamp, and error message for a clip job.
 *
 * @param {string} jobId
 * @param {object} updates
 * @param {string} updates.status
 * @param {Date|number} [updates.completedAt]
 * @param {string} [updates.errorMessage]
 * @returns {Promise<object|null>}
 */
export async function updateClipRequestStatus(jobId, { status, completedAt, errorMessage }) {
  if (!jobId) return null;

  const completed = completedAt ? new Date(completedAt) : new Date();
  const sql = `
    UPDATE clip_requests
    SET status = $1::VARCHAR,
        completed_at = CASE WHEN $1::VARCHAR IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN $2 ELSE completed_at END,
        error_message = $3
    WHERE job_id = $4
    RETURNING *;
  `;

  const res = await query(sql, [status, completed, errorMessage || null, jobId]);
  return res.rows[0] || null;
}

/**
 * Retrieves recent clip requests for a specific user.
 *
 * @param {string|number} telegramUserId
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.offset=0]
 * @returns {Promise<Array<object>>}
 */
export async function getUserClipRequests(telegramUserId, { limit = 5, offset = 0 } = {}) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT *
    FROM clip_requests
    WHERE telegram_user_id = $1
    ORDER BY requested_at DESC, id DESC
    LIMIT $2 OFFSET $3;
  `;
  const res = await query(sql, [uid, limit, offset]);
  return res.rows;
}

/**
 * Retrieves total count of clip requests for a user.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<number>}
 */
export async function getUserClipRequestCount(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT COUNT(*)::INTEGER AS count
    FROM clip_requests
    WHERE telegram_user_id = $1;
  `;
  const res = await query(sql, [uid]);
  return parseInt(res.rows[0]?.count || 0, 10);
}

/**
 * Retrieves a specific clip request by ID, strictly scoped to the requesting user.
 * Prevents unauthorized cross-user access to clips.
 *
 * @param {string|number} clipId
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>}
 */
export async function getClipRequestById(clipId, telegramUserId) {
  const uid = String(telegramUserId);
  const cid = parseInt(clipId, 10);
  if (isNaN(cid)) return null;

  const sql = `
    SELECT *
    FROM clip_requests
    WHERE id = $1 AND telegram_user_id = $2;
  `;
  const res = await query(sql, [cid, uid]);
  return res.rows[0] || null;
}

/**
 * Retrieves recent unique YouTube videos clipped by a user, grouped by canonical URL / video ID.
 *
 * @param {string|number} telegramUserId
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.offset=0]
 * @returns {Promise<Array<{ canonical_url: string, video_id: string|null, clip_count: number, last_used_at: Date }>>}
 */
export async function getRecentVideos(telegramUserId, { limit = 5, offset = 0 } = {}) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT
      COALESCE(canonical_url, youtube_url) AS canonical_url,
      video_id,
      COUNT(*)::INTEGER AS clip_count,
      MAX(requested_at) AS last_used_at
    FROM clip_requests
    WHERE telegram_user_id = $1
    GROUP BY COALESCE(canonical_url, youtube_url), video_id
    ORDER BY last_used_at DESC
    LIMIT $2 OFFSET $3;
  `;
  const res = await query(sql, [uid, limit, offset]);
  return res.rows;
}

/**
 * Retrieves the total count of distinct videos clipped by a user.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<number>}
 */
export async function getRecentVideoCount(telegramUserId) {
  const uid = String(telegramUserId);
  const sql = `
    SELECT COUNT(DISTINCT COALESCE(canonical_url, youtube_url))::INTEGER AS count
    FROM clip_requests
    WHERE telegram_user_id = $1;
  `;
  const res = await query(sql, [uid]);
  return parseInt(res.rows[0]?.count || 0, 10);
}

/**
 * Retrieves recent clips created from a specific video for a user.
 *
 * @param {string|number} telegramUserId
 * @param {string} canonicalUrlOrVideoId
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.offset=0]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentClipsForVideo(telegramUserId, canonicalUrlOrVideoId, { limit = 5, offset = 0 } = {}) {
  const uid = String(telegramUserId);
  const target = String(canonicalUrlOrVideoId);
  const videoId = extractYouTubeVideoId(target) || target;
  const canonicalUrl = canonicalizeYouTubeUrl(target);

  const sql = `
    SELECT *
    FROM clip_requests
    WHERE telegram_user_id = $1
      AND (
        canonical_url = $2
        OR youtube_url = $2
        OR (video_id IS NOT NULL AND video_id = $3)
      )
    ORDER BY requested_at DESC, id DESC
    LIMIT $4 OFFSET $5;
  `;
  const res = await query(sql, [uid, canonicalUrl, videoId, limit, offset]);
  return res.rows;
}

/**
 * Retrieves total clip count for a specific video and user.
 *
 * @param {string|number} telegramUserId
 * @param {string} canonicalUrlOrVideoId
 * @returns {Promise<number>}
 */
export async function getUserClipCountForVideo(telegramUserId, canonicalUrlOrVideoId) {
  const uid = String(telegramUserId);
  const target = String(canonicalUrlOrVideoId);
  const videoId = extractYouTubeVideoId(target) || target;
  const canonicalUrl = canonicalizeYouTubeUrl(target);

  const sql = `
    SELECT COUNT(*)::INTEGER AS count
    FROM clip_requests
    WHERE telegram_user_id = $1
      AND (
        canonical_url = $2
        OR youtube_url = $2
        OR (video_id IS NOT NULL AND video_id = $3)
      );
  `;
  const res = await query(sql, [uid, canonicalUrl, videoId]);
  return parseInt(res.rows[0]?.count || 0, 10);
}

/**
 * Retrieves the most recent clip requests globally.
 *
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentClipRequests({ limit = 10 } = {}) {
  const sql = `
    SELECT *
    FROM clip_requests
    ORDER BY requested_at DESC
    LIMIT $1;
  `;
  const res = await query(sql, [limit]);
  return res.rows;
}
