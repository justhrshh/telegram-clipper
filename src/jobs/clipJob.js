import crypto from 'node:crypto';
import { parseTimestampToSeconds } from '../utils/validator.js';

/**
 * Job data model and status states for background video clipping.
 */

export const JobStatus = Object.freeze({
  QUEUED: 'QUEUED',
  DOWNLOADING: 'DOWNLOADING',
  PROCESSING: 'PROCESSING',
  UPLOADING: 'UPLOADING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  // Backward compatibility alias:
  PENDING: 'QUEUED',
});

export class ClipJob {
  /**
   * @param {object} params
   * @param {string} [params.jobId]
   * @param {string|number} params.userId
   * @param {string|number} params.chatId
   * @param {string} params.url
   * @param {string} params.startTime
   * @param {string} params.endTime
   * @param {string} [params.ratio='vertical']
   * @param {boolean} [params.captions=false]
   * @param {string|null} [params.captionStyle=null]
   * @param {number|null} [params.statusMessageId=null]
   * @param {number} [params.priority=0]
   */
  constructor({
    jobId,
    userId,
    chatId,
    url,
    startTime,
    endTime,
    ratio = 'vertical',
    presentation = 'standard',
    captions = false,
    captionStyle = null,
    captionConfig = null,
    statusMessageId = null,
    priority = 0,
    batchId = null,
    batchIndex = 1,
    totalBatchClips = 1,
    batchProgressMessageId = null,
  }) {
    this.jobId = jobId || crypto.randomUUID();
    this.userId = String(userId);
    this.chatId = chatId;
    this.url = url;
    this.startTime = startTime;
    this.endTime = endTime;
    this.startSeconds = parseTimestampToSeconds(startTime) ?? 0;
    this.endSeconds = parseTimestampToSeconds(endTime) ?? 0;
    this.duration = Math.max(0, this.endSeconds - this.startSeconds);
    this.ratio = ratio || 'vertical';
    this.presentation = presentation || 'standard';
    this.captions = captions;
    this.captionStyle = captionStyle;
    this.captionConfig = captionConfig;
    this.statusMessageId = statusMessageId;
    this.priority = priority;
    this.batchId = batchId;
    this.batchIndex = batchIndex;
    this.totalBatchClips = totalBatchClips;
    this.batchProgressMessageId = batchProgressMessageId;

    this.createdAt = Date.now();
    this.status = JobStatus.QUEUED;
    this.currentStage = 'QUEUED';
    this.stage = 'queued';
    this.resourceType = 'none';

    this.startedAt = Date.now();
    this.completedAt = null;
    this.error = null;
    this.result = null;
  }
}
