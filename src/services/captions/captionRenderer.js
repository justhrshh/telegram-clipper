import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { PipelineStage, PipelineError } from '../../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONTS_DIR = path.resolve(__dirname, '../../../assets/fonts');

/**
 * Escapes file paths for safe inclusion in FFmpeg filtergraph strings on Windows.
 * Converts backslashes to forward slashes and escapes drive colons.
 *
 * @param {string} p
 * @returns {string}
 */
export function escapeFfmpegPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * Renders kinetic captions onto a 2160x3840 video using FFmpeg libass.
 *
 * @param {object} options
 * @param {string} options.videoPath - Input 4K video path
 * @param {string} options.assPath - Input .ass subtitles file path
 * @param {string} options.outputPath - Destination 4K video with burned-in captions
 * @param {string} options.jobId - Unique job identifier for logging
 * @param {number} [options.timeoutMs=240000] - 4-minute timeout
 * @returns {Promise<string>} Output video path
 */
export async function renderCaptionsOntoVideo({
  videoPath,
  assPath,
  outputPath,
  jobId = 'caption-render',
  timeoutMs = 240000,
}) {
  const safeAssPath = escapeFfmpegPath(assPath);
  const safeFontsDir = escapeFfmpegPath(FONTS_DIR);

  // Subtitle filter using libass with custom fonts directory
  const subtitleFilter = `subtitles='${safeAssPath}':fontsdir='${safeFontsDir}'`;

  const args = [
    '-i',
    videoPath,
    '-vf',
    subtitleFilter,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    // Audio stream copy (audio is already encoded in previous stage)
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ];

  logger.info(`[${jobId}] Burning kinetic captions onto video...`);

  return new Promise((resolve, reject) => {
    let stderrData = '';
    let isSettled = false;

    const proc = spawn('ffmpeg', args, { windowsHide: true });

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        proc.kill('SIGKILL');
        logger.error(`[${jobId}] [CAPTION_TIMEOUT] Caption rendering timed out after ${timeoutMs}ms`);
        reject(
          new PipelineError({
            stage: PipelineStage.CAPTION_RENDER_FAILED,
            message: `Caption rendering timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            exitCode: null,
            signal: 'SIGKILL',
            stderr: stderrData,
            stdout: '',
            jobId,
          })
        );
      }
    }, timeoutMs);

    proc.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    proc.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      logger.error(`[${jobId}] Failed to start FFmpeg for caption burning:`, err);
      reject(
        new PipelineError({
          stage: PipelineStage.CAPTION_RENDER_FAILED,
          message: `Failed to start FFmpeg for caption burning: ${err.message}`,
          exitCode: null,
          signal: null,
          stderr: stderrData,
          stdout: '',
          jobId,
          cause: err,
        })
      );
    });

    proc.on('close', (code, signal) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      if (code !== 0) {
        logger.error(
          `[${jobId}] [CAPTION_FAILED] FFmpeg subtitle burn failed with code ${code}.\n` +
          `  Stderr:\n${stderrData.trim() || '(empty)'}`
        );
        return reject(
          new PipelineError({
            stage: PipelineStage.CAPTION_RENDER_FAILED,
            message: `Failed to burn captions onto video (FFmpeg exit code ${code})`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: '',
            jobId,
          })
        );
      }

      logger.info(`[${jobId}] [CAPTION_SUCCESS] Captions successfully burned onto 4K video: ${outputPath}`);
      resolve(outputPath);
    });
  });
}
