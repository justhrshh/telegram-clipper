import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { PipelineStage, PipelineError } from '../../utils/errors.js';
import { config } from '../../config/env.js';
import { persistentTranscriptionManager } from './persistentWorkerManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const VENV_PYTHON = path.join(PROJECT_ROOT, '.venv/Scripts/python.exe');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'python/transcription.py');

/**
 * Extracts 16kHz mono audio from a video clip for Whisper ingestion.
 *
 * @param {string} videoPath - Input video file path
 * @param {string} audioOutputPath - Destination WAV path
 * @param {string} jobId - Job ID for logging
 * @returns {Promise<string>}
 */
export async function extractAudioFromClip(
  videoPath,
  audioOutputPath,
  jobId = 'audio',
  { startSeconds = 0, duration = null } = {}
) {
  const args = [];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push('-i', videoPath);
  if (duration !== null && duration > 0) {
    args.push('-t', String(duration));
  }
  args.push(
    '-vn', // Disable video recording
    '-acodec',
    'pcm_s16le', // Standard 16-bit PCM WAV
    '-ar',
    '16000', // 16kHz sample rate optimal for Whisper
    '-ac',
    '1', // Mono channel
    '-y',
    audioOutputPath
  );

  logger.info(`[${jobId}] Extracting 16kHz mono audio for transcription...`);

  return new Promise((resolve, reject) => {
    let stderrData = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });

    proc.stderr.on('data', (d) => (stderrData += d.toString()));

    proc.on('close', (code, signal) => {
      if (code === 0) {
        logger.info(`[${jobId}] Audio extracted successfully to: ${audioOutputPath}`);
        resolve(audioOutputPath);
      } else {
        logger.error(`[${jobId}] FFmpeg audio extraction failed with code ${code}: ${stderrData.slice(-500)}`);
        reject(
          new PipelineError({
            stage: PipelineStage.TRANSCRIPTION_FAILED,
            message: `Failed to extract audio from clip (FFmpeg exit code ${code})`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: '',
            jobId,
          })
        );
      }
    });

    proc.on('error', (err) => {
      reject(
        new PipelineError({
          stage: PipelineStage.TRANSCRIPTION_FAILED,
          message: `Failed to start audio extraction: ${err.message}`,
          exitCode: null,
          signal: null,
          stderr: '',
          stdout: '',
          jobId,
          cause: err,
        })
      );
    });
  });
}

/**
 * Transcribes an audio file via the persistent faster-whisper worker.
 *
 * The worker keeps the Whisper model loaded in VRAM between calls, so
 * per-request time is only inference time (~1–2s) rather than cold-load
 * time (~8s) on every clip.
 *
 * @param {object} options
 * @param {string} options.audioPath       - Path to WAV audio file
 * @param {string} options.jobDir          - Temporary job directory (kept for API compatibility, unused)
 * @param {string} options.jobId           - Unique job identifier
 * @param {string} [options.model]         - Whisper model name (default from env or 'large-v3')
 * @param {string} [options.device]        - 'auto' | 'cuda' | 'cpu'
 * @param {string} [options.computeType]   - 'auto' | 'int8_float16' | 'float16' | 'int8'
 * @param {number} [options.timeoutMs]     - Per-request timeout (default 300 000 ms)
 * @returns {Promise<{
 *   language: string,
 *   language_probability: number,
 *   duration: number,
 *   device: string,
 *   compute_type: string,
 *   model: string,
 *   words: Array<{ word: string, start: number, end: number }>,
 *   segments: Array<object>,
 *   word_count: number,
 *   model_load_time_sec: number,
 *   transcription_time_sec: number,
 *   start: number,
 *   end: number,
 *   durationMs: number
 * }>}
 */
export async function transcribeAudio({
  audioPath,
  jobDir,   // eslint-disable-line no-unused-vars  (kept for API compatibility)
  jobId,
  model = config.whisperModel || 'large-v3',
  device = config.whisperDevice || 'auto',
  computeType = config.whisperComputeType || 'auto',
  timeoutMs = 300000,
}) {
  const startTimestamp = Date.now();

  logger.info(
    `[${jobId}] [TRANSCRIPTION_START] Routing to persistent Whisper worker ` +
    `(model: ${model}, device: ${device}, compute: ${computeType})`
  );

  let rawResult;
  try {
    rawResult = await persistentTranscriptionManager.transcribe({ audioPath, jobId, timeoutMs });
  } catch (err) {
    logger.error(`[${jobId}] [TRANSCRIPTION_FAILED] Persistent worker error: ${err.message}`);
    throw new PipelineError({
      stage: PipelineStage.TRANSCRIPTION_FAILED,
      message: `Transcription failed: ${err.message}`,
      jobId,
      cause: err,
    });
  }

  const endTimestamp = Date.now();
  const durationMs = endTimestamp - startTimestamp;

  // Map persistent worker result to the same shape clipService / jobRunner expect.
  // Worker already returns: language, language_probability, word_count, words, segments,
  // device, compute_type, model, model_load_time_sec, transcription_time_sec.
  const transcript = {
    ...rawResult,
    word_count: rawResult.word_count ?? (rawResult.words ? rawResult.words.length : 0),
    start: startTimestamp,
    end: endTimestamp,
    durationMs,
  };

  const isGpu = transcript.device === 'cuda';
  const tag = isGpu ? 'GPU TRANSCRIPTION' : 'CPU TRANSCRIPTION';
  const modelLoadSec = transcript.model_load_time_sec ?? 0;
  const inferenceSec = transcript.transcription_time_sec ?? transcript.inference_time_s ?? '?';

  logger.info(
    `[${jobId}] [TRANSCRIPTION_SUCCESS] [${tag}] Completed in ${(durationMs / 1000).toFixed(2)}s!\n` +
    `  Words: ${transcript.word_count} | Lang: ${transcript.language} (${transcript.language_probability})\n` +
    `  Device: ${transcript.device} | Compute: ${transcript.compute_type} | Model: ${transcript.model}\n` +
    `  Model Load: ${modelLoadSec}s (persistent=warm) | Inference: ${inferenceSec}s`
  );

  return transcript;
}

/**
 * Runs the Python environment diagnostic probe.
 *
 * @returns {Promise<object>}
 */
export async function runTranscriptionDiagnostic() {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(VENV_PYTHON, [SCRIPT_PATH, '--diagnose'], { windowsHide: true });
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        reject(new Error(`Diagnostic exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}
