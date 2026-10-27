import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ensureGpuMemoryAvailable } from '../services/video/gpuMonitor.js';

class ResourceScheduler {
  constructor() {
    this.limits = {
      download: config.downloadConcurrency || 3,
      gpu: config.gpuEncodeConcurrency || 2,
      upload: config.uploadConcurrency || 3,
      userMax: config.maxActiveJobsPerUser || 2,
    };

    this.active = {
      download: 0,
      gpu: 0,
      upload: 0,
    };

    // Stage waiting queues: arrays of { jobId, userId, resolve, reject, enqueuedAt }
    this.queues = {
      download: [],
      gpu: [],
      upload: [],
    };

    // User tracking: Map<userId, Set<jobId>>
    this.userActiveJobs = new Map();

    // Stats tracking: Map<jobId, { downloadWaitTimeMs, gpuWaitTimeMs, uploadWaitTimeMs }>
    this.stats = new Map();
  }

  /**
   * Returns stats recorded for a job.
   */
  getJobStats(jobId) {
    return this.stats.get(jobId) || { downloadWaitTimeMs: 0, gpuWaitTimeMs: 0, uploadWaitTimeMs: 0 };
  }

  /**
   * Returns current concurrency telemetry string.
   */
  getTelemetry() {
    return (
      `[CONCURRENCY]\n` +
      `downloads=${this.active.download}/${this.limits.download}\n` +
      `encodes=${this.active.gpu}/${this.limits.gpu}\n` +
      `uploads=${this.active.upload}/${this.limits.upload}`
    );
  }

  /**
   * Logs current concurrency state with context jobId.
   */
  logState(jobId, action = '') {
    logger.info(`[JOB ${jobId}] [SCHEDULER_${action.toUpperCase()}]\n${this.getTelemetry()}`);
  }

  /**
   * Checks how many active jobs a user currently has in flight.
   */
  getUserActiveCount(userId) {
    const uid = String(userId);
    return this.userActiveJobs.get(uid)?.size || 0;
  }

  /**
   * Registers a job as active for a user.
   */
  registerUserJob(userId, jobId) {
    const uid = String(userId);
    if (!this.userActiveJobs.has(uid)) {
      this.userActiveJobs.set(uid, new Set());
    }
    this.userActiveJobs.get(uid).add(jobId);
    if (!this.stats.has(jobId)) {
      this.stats.set(jobId, { downloadWaitTimeMs: 0, gpuWaitTimeMs: 0, uploadWaitTimeMs: 0 });
    }
  }

  /**
   * Unregisters a job when it completes or fails.
   */
  unregisterUserJob(userId, jobId) {
    const uid = String(userId);
    const set = this.userActiveJobs.get(uid);
    if (set) {
      set.delete(jobId);
      if (set.size === 0) {
        this.userActiveJobs.delete(uid);
      }
    }
    // Trigger next items in queues
    this.pumpQueues();
  }

  /**
   * Finds the next eligible item in a queue respecting per-user fairness.
   */
  findNextEligibleItem(queue) {
    if (queue.length === 0) return null;

    // First pass: find candidate whose user is within fair userMax limit
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const activeCount = this.getUserActiveCount(item.userId);
      if (activeCount <= this.limits.userMax) {
        return queue.splice(i, 1)[0];
      }
    }

    // Fallback: take next FIFO item if all waiting users have jobs
    return queue.shift();
  }

  /**
   * Acquires a DOWNLOAD slot.
   *
   * @param {string} jobId
   * @param {string|number} userId
   * @param {(position: number) => void} [onQueued]
   * @returns {Promise<() => void>} Release function
   */
  async acquireDownloadSlot(jobId, userId, onQueued) {
    const uid = String(userId);
    this.registerUserJob(uid, jobId);
    const enqueueTime = Date.now();

    const grantSlot = (resolve) => {
      const waitTimeMs = Date.now() - enqueueTime;
      this.active.download++;
      const currentStats = this.getJobStats(jobId);
      currentStats.downloadWaitTimeMs = waitTimeMs;
      this.stats.set(jobId, currentStats);
      this.logState(jobId, `DOWNLOAD_ACQUIRED (waited: ${waitTimeMs}ms)`);
      const release = () => this.releaseDownloadSlot(jobId);
      release.waitTimeMs = waitTimeMs;
      resolve(release);
    };

    if (this.active.download < this.limits.download) {
      return new Promise((resolve) => grantSlot(resolve));
    }

    const position = this.queues.download.length + 1;
    logger.info(
      `[JOB ${jobId}] Download slots full (${this.active.download}/${this.limits.download}). Enqueued in download queue (position #${position}).`
    );
    if (typeof onQueued === 'function') {
      try { onQueued(position); } catch {}
    }

    return new Promise((resolve) => {
      this.queues.download.push({
        jobId,
        userId: uid,
        enqueuedAt: enqueueTime,
        resolve: () => grantSlot(resolve),
      });
    });
  }

  /**
   * Releases a DOWNLOAD slot and pumps waiting jobs.
   */
  releaseDownloadSlot(jobId) {
    if (this.active.download > 0) {
      this.active.download--;
    }
    this.logState(jobId, 'DOWNLOAD_RELEASED');

    if (this.queues.download.length > 0 && this.active.download < this.limits.download) {
      const next = this.findNextEligibleItem(this.queues.download);
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Acquires a GPU ENCODE slot.
   * Checks nvidia-smi VRAM availability before granting.
   *
   * @param {string} jobId
   * @param {string|number} userId
   * @param {(position: number) => void} [onQueued]
   * @returns {Promise<(() => void) & { waitTimeMs: number }>} Release function
   */
  async acquireGpuSlot(jobId, userId, onQueued) {
    const uid = String(userId);
    const enqueueTime = Date.now();

    const grantSlot = async (resolve) => {
      const waitTimeMs = Date.now() - enqueueTime;
      // Inspect GPU memory before granting
      await ensureGpuMemoryAvailable(jobId, 500, 3000);
      this.active.gpu++;
      const currentStats = this.getJobStats(jobId);
      currentStats.gpuWaitTimeMs = waitTimeMs;
      this.stats.set(jobId, currentStats);
      this.logState(jobId, `GPU_ACQUIRED (waited: ${waitTimeMs}ms)`);
      const release = () => this.releaseGpuSlot(jobId);
      release.waitTimeMs = waitTimeMs;
      resolve(release);
    };

    if (this.active.gpu < this.limits.gpu) {
      return new Promise((resolve) => {
        void grantSlot(resolve);
      });
    }

    const position = this.queues.gpu.length + 1;
    logger.info(
      `[JOB ${jobId}] GPU slots full (${this.active.gpu}/${this.limits.gpu}). Enqueued in GPU queue (position #${position}).`
    );
    if (typeof onQueued === 'function') {
      try { onQueued(position); } catch {}
    }

    return new Promise((resolve) => {
      this.queues.gpu.push({
        jobId,
        userId: uid,
        enqueuedAt: enqueueTime,
        resolve: () => {
          void grantSlot(resolve);
        },
      });
    });
  }

  /**
   * Releases a GPU ENCODE slot immediately after FFmpeg completes.
   */
  releaseGpuSlot(jobId) {
    if (this.active.gpu > 0) {
      this.active.gpu--;
    }
    this.logState(jobId, 'GPU_RELEASED');

    if (this.queues.gpu.length > 0 && this.active.gpu < this.limits.gpu) {
      const next = this.findNextEligibleItem(this.queues.gpu);
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Acquires an UPLOAD slot for Telegram delivery.
   *
   * @param {string} jobId
   * @param {string|number} userId
   * @param {(position: number) => void} [onQueued]
   * @returns {Promise<(() => void) & { waitTimeMs: number }>} Release function
   */
  async acquireUploadSlot(jobId, userId, onQueued) {
    const uid = String(userId);
    const enqueueTime = Date.now();

    const grantSlot = (resolve) => {
      const waitTimeMs = Date.now() - enqueueTime;
      this.active.upload++;
      const currentStats = this.getJobStats(jobId);
      currentStats.uploadWaitTimeMs = waitTimeMs;
      this.stats.set(jobId, currentStats);
      this.logState(jobId, `UPLOAD_ACQUIRED (waited: ${waitTimeMs}ms)`);
      const release = () => this.releaseUploadSlot(jobId);
      release.waitTimeMs = waitTimeMs;
      resolve(release);
    };

    if (this.active.upload < this.limits.upload) {
      return new Promise((resolve) => grantSlot(resolve));
    }

    const position = this.queues.upload.length + 1;
    logger.info(
      `[JOB ${jobId}] Upload slots full (${this.active.upload}/${this.limits.upload}). Enqueued in upload queue (position #${position}).`
    );
    if (typeof onQueued === 'function') {
      try { onQueued(position); } catch {}
    }

    return new Promise((resolve) => {
      this.queues.upload.push({
        jobId,
        userId: uid,
        enqueuedAt: enqueueTime,
        resolve: () => grantSlot(resolve),
      });
    });
  }

  /**
   * Releases an UPLOAD slot and pumps waiting uploads.
   */
  releaseUploadSlot(jobId) {
    if (this.active.upload > 0) {
      this.active.upload--;
    }
    this.logState(jobId, 'UPLOAD_RELEASED');

    if (this.queues.upload.length > 0 && this.active.upload < this.limits.upload) {
      const next = this.findNextEligibleItem(this.queues.upload);
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Pumps all queues to ensure any available slots are claimed.
   */
  pumpQueues() {
    while (this.queues.download.length > 0 && this.active.download < this.limits.download) {
      const next = this.findNextEligibleItem(this.queues.download);
      if (next) next.resolve();
      else break;
    }
    while (this.queues.gpu.length > 0 && this.active.gpu < this.limits.gpu) {
      const next = this.findNextEligibleItem(this.queues.gpu);
      if (next) next.resolve();
      else break;
    }
    while (this.queues.upload.length > 0 && this.active.upload < this.limits.upload) {
      const next = this.findNextEligibleItem(this.queues.upload);
      if (next) next.resolve();
      else break;
    }
  }
}

export const scheduler = new ResourceScheduler();
