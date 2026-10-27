import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const VENV_PYTHON = path.join(PROJECT_ROOT, '.venv/Scripts/python.exe');
const PERSISTENT_SCRIPT = path.join(PROJECT_ROOT, 'python/persistent_worker.py');
const VENV_SITE_PACKAGES = path.join(PROJECT_ROOT, '.venv/Lib/site-packages');

// NVIDIA DLL bin directories to inject into PATH
const NVIDIA_BIN_DIRS = [
  path.join(VENV_SITE_PACKAGES, 'nvidia/cublas/bin'),
  path.join(VENV_SITE_PACKAGES, 'nvidia/cudnn/bin'),
  path.join(VENV_SITE_PACKAGES, 'nvidia/cuda_nvrtc/bin'),
  path.join(VENV_SITE_PACKAGES, 'nvidia/cuda_runtime/bin'),
  path.join(VENV_SITE_PACKAGES, 'ctranslate2'),
];

class PersistentTranscriptionManager {
  constructor() {
    this.process = null;
    this.readline = null;
    this.isReady = false;
    this.initPromise = null;
    this.pendingRequests = new Map();
    this.reqCounter = 0;
    this.modelInfo = {
      model: config.whisperModel || 'large-v3',
      device: 'unknown',
      compute_type: 'unknown',
    };
  }

  /**
   * Initializes or returns the existing persistent Python worker.
   *
   * @returns {Promise<object>} Model info
   */
  async ensureReady() {
    if (this.isReady && this.process && !this.process.killed) {
      return this.modelInfo;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._startWorker();
    return this.initPromise;
  }

  async _startWorker() {
    // Verify python executable
    try {
      await fs.access(VENV_PYTHON);
    } catch (err) {
      this.initPromise = null;
      throw new Error(`Python virtual environment not found at ${VENV_PYTHON}`);
    }

    const t0 = Date.now();
    logger.info('[transcription] Starting persistent Python Whisper worker in background...');

    // Construct enhanced PATH containing NVIDIA DLL directories
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const enhancedPath = NVIDIA_BIN_DIRS.join(pathSep) + pathSep + (process.env.PATH || '');

    const env = {
      ...process.env,
      PATH: enhancedPath,
      WHISPER_MODEL: config.whisperModel || 'large-v3',
      WHISPER_DEVICE: config.whisperDevice || 'auto',
      WHISPER_COMPUTE_TYPE: config.whisperComputeType || 'int8_float16',
    };

    return new Promise((resolve, reject) => {
      let isSettled = false;

      try {
        this.process = spawn(VENV_PYTHON, [PERSISTENT_SCRIPT], {
          windowsHide: true,
          env,
        });
      } catch (spawnErr) {
        this.initPromise = null;
        return reject(spawnErr);
      }

      this.readline = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      // Stream stderr logs
      this.process.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          logger.info(`[whisper-worker] ${text}`);
        }
      });

      // Handle stdout lines (JSON protocol)
      this.readline.on('line', (line) => {
        line = line.trim();
        if (!line) return;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        // Ready notification on worker startup
        if (msg.status === 'ready' && !isSettled) {
          isSettled = true;
          this.isReady = true;
          this.modelInfo = {
            model: msg.model,
            device: msg.device,
            compute_type: msg.compute_type,
            load_time_s: msg.load_time_s,
          };
          const startupSec = ((Date.now() - t0) / 1000).toFixed(2);
          logger.info(
            `[transcription] Persistent Whisper worker ready in ${startupSec}s ` +
            `(${msg.device}/${msg.compute_type}, ${msg.model})`
          );
          resolve(this.modelInfo);
          return;
        }

        // Handle transcription response
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolveReq, rejectReq, timer } = this.pendingRequests.get(msg.id);
          clearTimeout(timer);
          this.pendingRequests.delete(msg.id);

          if (msg.status === 'ok') {
            resolveReq(msg.result);
          } else {
            rejectReq(new Error(msg.error || 'Transcription failed'));
          }
        }
      });

      this.process.on('close', (code, signal) => {
        logger.warn(`[transcription] Persistent worker exited with code ${code}, signal ${signal}`);
        this.isReady = false;
        this.initPromise = null;
        this.process = null;

        // Reject all pending requests
        for (const [id, { rejectReq, timer }] of this.pendingRequests.entries()) {
          clearTimeout(timer);
          rejectReq(new Error(`Whisper worker terminated unexpectedly (code: ${code})`));
        }
        this.pendingRequests.clear();

        if (!isSettled) {
          isSettled = true;
          reject(new Error(`Whisper worker failed to initialize (code: ${code})`));
        }
      });

      this.process.on('error', (err) => {
        logger.error('[transcription] Persistent worker error:', err);
        if (!isSettled) {
          isSettled = true;
          this.initPromise = null;
          reject(err);
        }
      });

      // Startup timeout (e.g. 60 seconds for cold model download/load)
      setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.initPromise = null;
          try {
            this.process.kill();
          } catch {}
          reject(new Error('Whisper persistent worker timed out during initialization'));
        }
      }, 60000);
    });
  }

  /**
   * Transcribes an audio file via the resident worker.
   *
   * @param {object} params
   * @param {string} params.audioPath
   * @param {string} params.jobId
   * @param {number} [params.timeoutMs=180000]
   * @returns {Promise<object>}
   */
  async transcribe({ audioPath, jobId, timeoutMs = 180000 }) {
    await this.ensureReady();

    const reqId = `tr_${jobId}_${++this.reqCounter}`;
    const payload = {
      id: reqId,
      action: 'transcribe',
      audio: audioPath,
      beam_size: 1,
      vad_filter: true,
    };

    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        rejectReq(new Error(`Transcription timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolveReq, rejectReq, timer });

      try {
        this.process.stdin.write(JSON.stringify(payload) + '\n');
      } catch (writeErr) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        rejectReq(writeErr);
      }
    });
  }

  /**
   * Gracefully shuts down the persistent worker.
   */
  shutdown() {
    if (this.process && !this.process.killed) {
      try {
        this.process.stdin.end();
        this.process.kill();
      } catch {}
      this.isReady = false;
      this.process = null;
    }
  }
}

// Export singleton instance
export const persistentTranscriptionManager = new PersistentTranscriptionManager();
