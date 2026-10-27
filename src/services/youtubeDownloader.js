import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { PipelineStage, PipelineError, sanitizeUrl, sanitizeArgs } from '../utils/errors.js';
import { parseTimestampToSeconds } from '../utils/validator.js';
import { TELEGRAM_CLIPPER_BUILD } from '../config/version.js';
import { config } from '../config/env.js';
import { probeMedia } from './videoProcessor.js';
import { traceAudioStage } from './video/audioPreservation.js';
import { getYtDlpAuthArgs, getYtDlpAuthDiagnostics, sanitizeYtDlpArgs } from './youtube/youtubeAuth.js';
import { classifyDownloadError, isRecoverableViaFullDownload, DownloadErrorType } from './youtube/youtubeErrorClassifier.js';

/**
 * Configurable timeouts from environment variables with safe defaults.
 * 90s stall timeout gives remote DASH connections/manifest handshakes ample time
 * while detecting genuine connection drops.
 */
const DOWNLOAD_STALL_TIMEOUT_MS = Number(process.env.DOWNLOAD_STALL_TIMEOUT_MS) || 180000;
const MAX_JOB_DURATION_MS = Number(process.env.MAX_JOB_DURATION_MS) || 900000; // 15 minutes max

/**
 * Safely terminates a process tree on Windows using taskkill /T /F.
 *
 * @param {number} pid - Process ID to terminate
 */
function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`, (err) => {
      if (err) {
        logger.debug(`[PID ${pid}] taskkill notice: ${err.message}`);
      }
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

/**
 * Checks whether a directory exists and is writable.
 *
 * @param {string} dirPath
 * @returns {Promise<{ exists: boolean, writable: boolean }>}
 */
async function inspectDirectoryAccess(dirPath) {
  let exists = false;
  let writable = false;
  try {
    await fs.access(dirPath);
    exists = true;
    const testFile = path.join(dirPath, `.write_check_${Date.now()}`);
    await fs.writeFile(testFile, 'test');
    await fs.unlink(testFile);
    writable = true;
  } catch {
    writable = false;
  }
  return { exists, writable };
}

/**
 * Lists all files in a directory along with their sizes in bytes.
 *
 * @param {string} dirPath
 * @returns {Promise<Array<{ name: string, size: number, sizeMB: string }>>}
 */
async function listDirectoryContents(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    const results = [];
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) {
        results.push({
          name: file,
          size: stat.size,
          sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Valid completed video extensions.
 */
const VALID_VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm']);

/**
 * Classifies a raw protocol string from yt-dlp.
 *
 * @param {string} proto
 * @returns {'https'|'http'|'dash'|'hls'|string}
 */
export function classifyProtocol(proto = '') {
  const p = String(proto).toLowerCase();
  if (p.includes('m3u8')) return 'hls';
  if (p.includes('dash')) return 'dash';
  if (p.startsWith('https')) return 'https';
  if (p.startsWith('http')) return 'http';
  return p;
}

/**
 * Assigns a priority rank to the protocol.
 * Direct HTTP/HTTPS: 3 (highest)
 * DASH: 2
 * HLS: 1 (lowest, only as last resort)
 */
export function getProtocolRank(protoType) {
  if (protoType === 'https' || protoType === 'http') return 3;
  if (protoType === 'dash') return 2;
  if (protoType === 'hls') return 1;
  return 0;
}

/**
 * Builds standard yt-dlp format selector:
 * 1. Video: highest practical quality up to targetMaxHeight (default 2160p), preferring direct HTTP/HTTPS and DASH over HLS.
 * 2. Audio: strictly selects the creator's original upload audio track, rejecting localized regional defaults,
 *    dubs, translations, commentary, audio descriptions, and DRC variants.
 *
 * @param {object} [options]
 * @param {number} [options.targetMaxHeight=2160]
 * @returns {string}
 */
export function buildMediaFormatSelector({ targetMaxHeight = 2160 } = {}) {
  const heightFilter = targetMaxHeight ? `[height<=${targetMaxHeight}]` : '';

  const videoSelector =
    `bestvideo[protocol^=http]${heightFilter}/` +
    `bestvideo[protocol*=dash]${heightFilter}/` +
    `bestvideo${heightFilter}/best`;

  const audioSelector =
    `bestaudio[format_note*=original][protocol^=http][ext=m4a]/` +
    `bestaudio[format_note*=original][protocol^=http]/` +
    `bestaudio[language_preference>=10][protocol^=http][ext=m4a]/` +
    `bestaudio[language_preference>=10][protocol^=http]/` +
    `bestaudio[format_id!*=drc][format_note!*=dubbed][format_note!*=descriptive][protocol^=http][ext=m4a]/` +
    `bestaudio[format_id!*=drc][format_note!*=dubbed][format_note!*=descriptive][protocol^=http]/` +
    `bestaudio[protocol^=http][ext=m4a]/` +
    `bestaudio[protocol^=http]/` +
    `bestaudio`;

  return `(${videoSelector})+(${audioSelector})/best`;
}

// In-memory format decision cache keyed by sanitized URL and targetMaxHeight (TTL: 10 minutes)
export const formatDecisionCache = new Map();
export const FORMAT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Inspects available video/audio formats for a URL and selects optimal streams
 * using yt-dlp's standard format selection behavior.
 * Purely passive media acquisition: selects best practical video and naturally associated default audio.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.jobId
 * @param {number} [params.targetMaxHeight=2160]
 * @returns {Promise<{
 *   formatSelector: string,
 *   selectedVideo: object|null,
 *   selectedAudio: object|null,
 *   originalLanguage: string|null,
 *   isHls: boolean,
 *   videoProtocol: string,
 *   audioProtocol: string
 * }>}
 */
export async function inspectAndSelectFormats({ url, jobId, targetMaxHeight = 2160 }) {
  const sanitizedUrl = sanitizeUrl(url);
  const cacheKey = `${sanitizedUrl}_${targetMaxHeight}`;
  const cached = formatDecisionCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < FORMAT_CACHE_TTL_MS)) {
    logger.info(`[${jobId}] [FORMAT CACHE HIT] Reusing cached format decision for ${sanitizedUrl}`);
    return cached.decision;
  }

  logger.info(`[${jobId}] Inspecting formats for ${sanitizedUrl} (standard media selection, target canvas limit: ${targetMaxHeight}p)...`);

  const nodeRuntimeSpec = process.execPath ? `node:${process.execPath}` : 'node';
  const formatSort = 'res,fps,codec:h264,proto';
  const standardSelector = buildMediaFormatSelector({ targetMaxHeight });

  async function fetchFormatJson(useMobileFallback = false) {
    const clients = useMobileFallback
      ? 'youtube:player_client=web_embedded,mweb,ios,android,tv'
      : 'youtube:player_client=default,web_embedded,ios,android,mweb,tv';
    const authArgs = getYtDlpAuthArgs();

    return new Promise((resolve, reject) => {
      const child = spawn(
        'py',
        [
          '-m', 'yt_dlp',
          '-4',
          ...authArgs,
          '-J',
          '--no-warnings',
          '--no-playlist',
          '--js-runtimes', nodeRuntimeSpec,
          '--extractor-args', clients,
          '-S', formatSort,
          '-f', standardSelector,
          url,
        ],
        { windowsHide: true, maxBuffer: 50 * 1024 * 1024 }
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => {
        if (code === 0 && out.trim()) {
          resolve(out);
        } else {
          reject(new Error(`yt-dlp format extraction failed (code ${code}): ${err.slice(-400)}`));
        }
      });
      child.on('error', reject);
    });
  }

  try {
    let stdout;
    try {
      stdout = await fetchFormatJson(false);
    } catch (primaryErr) {
      const classified = classifyDownloadError(primaryErr.message, '', primaryErr);
      if (
        classified.type === DownloadErrorType.BOT_VERIFICATION_REQUIRED ||
        classified.type === DownloadErrorType.NETWORK_ERROR ||
        primaryErr.message.includes('429')
      ) {
        logger.warn(
          `[${jobId}] [BOT_CHALLENGE_AUTO_FALLBACK] Web client encountered challenge/429. Retrying with mobile player clients (ios, android, tv)...`
        );
        stdout = await fetchFormatJson(true);
        logger.info(`[${jobId}] [BOT_CHALLENGE_RESOLVED] Successfully resolved formats via mobile client fallback.`);
      } else {
        throw primaryErr;
      }
    }

    const info = JSON.parse(stdout);
    const reqFormats = info.requested_formats || [];
    const selectedVideo = reqFormats.find((f) => f.vcodec && f.vcodec !== 'none') || info;
    const selectedAudio = reqFormats.find((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) || info;
    const originalLanguage = info.original_language || (info.language && info.language !== 'und' ? info.language : null);

    const vProto = classifyProtocol(selectedVideo.protocol);
    const aProto = classifyProtocol(selectedAudio.protocol);
    const isHls = vProto === 'hls' || aProto === 'hls';

    logger.info(
      `\n[AUDIO SELECTION]\n` +
      `track_type=CREATOR_ORIGINAL\n` +
      `language=${selectedAudio.language || originalLanguage || 'en'}\n` +
      `format_id=${selectedAudio.format_id}\n` +
      `selected=true\n\n` +
      `[AUDIO PROCESSING]\n` +
      `processing=false\n` +
      `reencoding=false\n` +
      `filtering=false\n` +
      `mixing=false\n` +
      `timestamp_shift=false\n\n` +
      `[MEDIA SELECTION]\n` +
      `video_format=${selectedVideo.format_id}\n` +
      `audio_format=${selectedAudio.format_id}\n` +
      `selection_mode=STANDARD`
    );

    logger.info(
      `\n[FORMAT DECISION]\n` +
      `video_format=${selectedVideo.format_id}\n` +
      `video_protocol=${vProto}\n` +
      `video_codec=${selectedVideo.vcodec}\n` +
      `video_resolution=${selectedVideo.resolution || (selectedVideo.width && selectedVideo.height ? `${selectedVideo.width}x${selectedVideo.height}` : `${selectedVideo.height || 'unknown'}p`)}\n` +
      `video_fps=${selectedVideo.fps || 'unknown'}\n` +
      `audio_format=${selectedAudio.format_id}\n` +
      `audio_protocol=${aProto}\n` +
      `audio_codec=${selectedAudio.acodec}`
    );

    if (isHls) {
      logger.warn(
        `\n[FORMAT DECISION]\nWARNING=HLS_SELECTED\n` +
        `[RANGE MODE]\nmode=HLS_FALLBACK\n` +
        `[PERFORMANCE WARNING]\nreason=HLS source selected\nmessage=Fast direct-range path unavailable for selected format\n`
      );
    } else {
      logger.info(
        `\n[PERFORMANCE]\nrange-capable source=true\nprotocol=${vProto}\n`
      );
    }

    const totalDuration = Number(info.duration || selectedVideo?.duration || 0);

    const decision = {
      formatSelector: standardSelector,
      selectedVideo,
      selectedAudio,
      originalLanguage,
      isHls,
      videoProtocol: vProto,
      audioProtocol: aProto,
      totalDuration,
    };
    formatDecisionCache.set(cacheKey, { decision, timestamp: Date.now() });
    return decision;
  } catch (err) {
    const classified = classifyDownloadError(err.message, '', err);
    if (!isRecoverableViaFullDownload(classified)) {
      logger.error(
        `[${jobId}] [PREFLIGHT_AUTH_CHALLENGE] YouTube format inspection halted:\n` +
        `  error_type=${classified.type}\n` +
        `  reason=${classified.developerNote}\n` +
        `  action=Failing fast to prevent redundant blocked requests`
      );
      throw new PipelineError({
        stage: PipelineStage.DOWNLOAD_FAILED,
        code: classified.type,
        message: classified.userMessage,
        classification: classified,
        jobId,
        cause: err,
      });
    }
    logger.warn(`[${jobId}] Pre-download format inspection failed, falling back to standard selector:`, err.message);
  }

  logger.info(`[${jobId}] [FORMAT DECISION] Using fallback standard selector: ${standardSelector}`);

  return {
    formatSelector: standardSelector,
    selectedVideo: null,
    selectedAudio: null,
    originalLanguage: null,
    isHls: false,
    videoProtocol: 'unknown',
    audioProtocol: 'unknown',
  };
}

/**
 * Low-level execution of yt-dlp via the Python launcher with active progress watchdog.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.effectiveJobDir
 * @param {string} params.outputTemplate
 * @param {string|null} params.sectionRange - Slicing range (e.g. '*00:10-00:25' or '*180-210') or null
 * @param {string} params.jobId
 * @param {number} params.stallTimeoutMs
 * @param {number} params.maxDurationMs
 * @param {number|null} [params.requestedDuration]
 * @param {string} [params.formatSelector]
 * @returns {Promise<{ sourcePath: string, filename: string, metadata: object, downloadMetrics: object, formatDecision?: object }>}
 */
async function executeYtDlpDownload({
  url,
  effectiveJobDir,
  outputTemplate,
  sectionRange = null,
  jobId,
  stallTimeoutMs,
  maxDurationMs,
  requestedDuration = null,
  formatSelector = null,
  formatDecision = null,
  forceMobile = false,
}) {
  const sanitizedUrl = sanitizeUrl(url);
  const tempRootDir = path.dirname(effectiveJobDir);
  const executable = 'py';
  const authArgs = getYtDlpAuthArgs();
  const authDiagnostics = getYtDlpAuthDiagnostics();
  const nodeRuntimeSpec = process.execPath ? `node:${process.execPath}` : 'node';
  const playerClients = forceMobile
    ? 'youtube:player_client=web_embedded,mweb,ios,android,tv'
    : 'youtube:player_client=default,web_embedded,ios,android,mweb,tv';

  // Build argument array
  const args = [
    '-m',
    'yt_dlp',
    '-4',
    ...authArgs,
    // Supply Node.js as the JavaScript runtime to resolve YouTube bot/n-sig challenges
    '--js-runtimes',
    nodeRuntimeSpec,
    '--extractor-args',
    playerClients,
    // Sort preference: highest resolution, highest fps up to 60, H.264 codec, direct protocol
    '-S',
    'res,fps,codec:h264,proto',
    // Format selector: prefer passed formatDecision, fallback to buildMediaFormatSelector
    '-f',
    formatSelector || buildMediaFormatSelector({
      targetMaxHeight: config.outputQualityMode === 'maximum' ? 2160 : 1080,
    }),
    // Merge streams using ffmpeg into mp4 container
    '--merge-output-format',
    'mp4',
    // Single video only, prevent downloading whole playlists
    '--no-playlist',
    // Output template in the job-specific directory
    '-o',
    outputTemplate,
    // Provide clean progress info
    '--no-warnings',
  ];

  if (sectionRange) {
    args.push('--download-sections', sectionRange);
    // Bounded chunk Range requests + robust network reconnect:
    // 1) 10MB chunk windows completely bypass Google Video's 84 KB/s playback pacing throttle
    // 2) -reconnect_on_network_error auto-reconnects on dropped TCP/TLS connections to prevent error -138
    args.push('--downloader-args', 'ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5 -request_size 10485760 -initial_request_size 1048576 -seekable 1');
  }

  // Provide video URL as last argument
  args.push(url);

  const sanitizedArgs = sanitizeYtDlpArgs(sanitizeArgs(args));
  const actualCommandString = `${executable} ${sanitizedArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

  // Preflight directory audit
  const tempRootAccess = await inspectDirectoryAccess(tempRootDir);
  const effectiveJobDirAccess = await inspectDirectoryAccess(effectiveJobDir);

  logger.info(
    `[${jobId}] [DOWNLOAD_PREFLIGHT] [Build: ${TELEGRAM_CLIPPER_BUILD}]\n` +
    `  Process PID:         ${process.pid}\n` +
    `  Working Dir (CWD):   ${process.cwd()}\n` +
    `  Executable:          ${executable}\n` +
    `  Actual Command:      ${actualCommandString}\n` +
    `  YouTube Auth:        ${authDiagnostics.description}\n` +
    `  Target URL:          ${sanitizedUrl}\n` +
    `  Section Trimming:    ${sectionRange || 'Disabled (Full Download)'}\n` +
    `  Temp Root:           ${tempRootDir} (exists: ${tempRootAccess.exists}, writable: ${tempRootAccess.writable})\n` +
    `  Job Directory:       ${effectiveJobDir} (exists: ${effectiveJobDirAccess.exists}, writable: ${effectiveJobDirAccess.writable})\n` +
    `  Stall Timeout:       ${stallTimeoutMs}ms (${Math.round(stallTimeoutMs / 1000)}s inactivity limit)\n` +
    `  Max Job Duration:    ${maxDurationMs}ms (${Math.round(maxDurationMs / 1000)}s hard limit)`
  );

  const startTimeMs = Date.now();

  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let isSettled = false;
    let selectedFormatInfo = 'unknown';
    let lastProgressAt = Date.now();
    let lastDiskBytes = 0;

    // Spawn subprocess via Python launcher
    const proc = spawn(executable, args, {
      cwd: process.cwd(),
      windowsHide: true,
    });

    logger.info(`[${jobId}] [DOWNLOAD_SPAWNED] Subprocess PID: ${proc.pid}`);

    // Active progress watchdog: checks every 2 seconds for stdout, stderr, or disk activity
    const watchdogInterval = setInterval(async () => {
      if (isSettled) {
        clearInterval(watchdogInterval);
        return;
      }

      const now = Date.now();

      // Check disk activity: examine all files in jobDir (including .part files growing)
      try {
        const currentFiles = await listDirectoryContents(effectiveJobDir);
        let totalBytes = 0;
        for (const f of currentFiles) {
          totalBytes += f.size;
        }
        if (totalBytes > lastDiskBytes) {
          lastDiskBytes = totalBytes;
          lastProgressAt = now; // Actively downloading to disk
        }
      } catch {}

      const inactiveMs = now - lastProgressAt;
      const totalElapsedMs = now - startTimeMs;

      // Check for genuine stall
      if (inactiveMs > stallTimeoutMs) {
        isSettled = true;
        clearInterval(watchdogInterval);
        const stallSec = (inactiveMs / 1000).toFixed(1);
        const totalSec = (totalElapsedMs / 1000).toFixed(2);

        logger.error(
          `[${jobId}] [DOWNLOAD_STALLED] Subprocess stalled! No activity (network or disk) for ${stallSec}s (limit: ${stallTimeoutMs}ms). Total time: ${totalSec}s.\n` +
          `  Executable:      ${executable}\n` +
          `  Subprocess PID:  ${proc.pid}\n` +
          `  Selected Format: ${selectedFormatInfo}\n` +
          `  URL:             ${sanitizedUrl}\n` +
          `  Partial Stdout:\n${stdoutData.slice(-500) || '(empty)'}\n` +
          `  Partial Stderr:\n${stderrData.slice(-500) || '(empty)'}`
        );

        terminateProcessTree(proc.pid);

        const stallErr = new PipelineError({
          stage: PipelineStage.DOWNLOAD_FAILED,
          message: `Download stalled: no data received from YouTube for ${stallSec} seconds.`,
          exitCode: null,
          signal: 'SIGKILL',
          stderr: stderrData,
          stdout: stdoutData,
          jobId,
        });

        reject(stallErr);
        return;
      }

      // Check hard ceiling
      if (totalElapsedMs > maxDurationMs) {
        isSettled = true;
        clearInterval(watchdogInterval);
        const elapsedSec = (totalElapsedMs / 1000).toFixed(2);

        logger.error(
          `[${jobId}] [DOWNLOAD_MAX_TIMEOUT] Download exceeded maximum duration of ${elapsedSec}s (limit: ${maxDurationMs}ms).\n` +
          `  Subprocess PID:  ${proc.pid}`
        );

        terminateProcessTree(proc.pid);

        const maxTimeoutErr = new PipelineError({
          stage: PipelineStage.DOWNLOAD_FAILED,
          message: `YouTube download exceeded maximum job duration of ${Math.round(maxDurationMs / 1000)} seconds.`,
          exitCode: null,
          signal: 'SIGKILL',
          stderr: stderrData,
          stdout: stdoutData,
          jobId,
        });

        reject(maxTimeoutErr);
      }
    }, 2000);

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutData += text;

      // Update watchdog: active progress received
      lastProgressAt = Date.now();

      // Detect and log selected format
      const formatMatch = text.match(/Downloading 1 format\(s\):\s*([^\r\n]+)/);
      if (formatMatch) {
        selectedFormatInfo = formatMatch[1].trim();
        logger.info(`[${jobId}] [YT_DLP_FORMAT_SELECTED] ${selectedFormatInfo}`);
      }

      // Stream download progress lines
      const lines = text.split(/[\r\n]+/).filter(Boolean);
      for (const line of lines) {
        if (line.includes('[download]') || line.includes('[info]') || line.includes('[Merger]') || line.includes('Solving JS')) {
          logger.info(`[${jobId}] [yt-dlp] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrData += text;

      // Update watchdog if progress is reported on stderr (ffmpeg reports frame= on stderr)
      if (text.includes('frame=') || text.includes('size=') || text.includes('time=') || text.includes('bitrate=')) {
        lastProgressAt = Date.now();
      }

      logger.warn(`[${jobId}] [yt-dlp-stderr] ${text.trim()}`);
    });

    proc.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearInterval(watchdogInterval);
      const elapsedSec = ((Date.now() - startTimeMs) / 1000).toFixed(2);

      logger.error(
        `[${jobId}] [DOWNLOAD_SPAWN_ERROR] Failed to start downloader process after ${elapsedSec}s:\n` +
        `  Executable: ${executable}\n` +
        `  Error:      ${err.message}\n` +
        `  Stack:      ${err.stack}\n` +
        `  URL:        ${sanitizedUrl}`
      );

      const spawnErr = new PipelineError({
        stage: PipelineStage.DOWNLOAD_FAILED,
        message: `Failed to start downloader process: ${err.message}`,
        exitCode: null,
        signal: null,
        stderr: stderrData,
        stdout: stdoutData,
        jobId,
        cause: err,
      });

      reject(spawnErr);
    });

    proc.on('close', async (code, signal) => {
      if (isSettled) return;
      isSettled = true;
      clearInterval(watchdogInterval);

      const elapsedSec = ((Date.now() - startTimeMs) / 1000).toFixed(2);
      const presentFiles = await listDirectoryContents(effectiveJobDir);
      const fileReport = presentFiles.length > 0
        ? presentFiles.map((f) => `• ${f.name}: ${f.size} bytes (${f.sizeMB} MB)`).join('\n  ')
        : '(no files present)';

      if (code !== 0) {
        const classified = classifyDownloadError(stderrData, stdoutData);

        logger.error(
          `[${jobId}] [DOWNLOAD_FAILED] yt-dlp process exited with error:\n` +
          `  Exit Code:       ${code}\n` +
          `  Classification:  ${classified.type}\n` +
          `  Auth Issue:      ${classified.isAuthIssue}\n` +
          `  Signal:          ${signal ?? 'none'}\n` +
          `  Elapsed Time:    ${elapsedSec}s\n` +
          `  Executable:      ${executable}\n` +
          `  Subprocess PID:  ${proc.pid}\n` +
          `  Actual Command:  ${actualCommandString}\n` +
          `  YouTube Auth:    ${authDiagnostics.description}\n` +
          `  Target URL:      ${sanitizedUrl}\n` +
          `  Output Dir:      ${effectiveJobDir}\n` +
          `  Files in Dir:\n  ${fileReport}\n` +
          `  Selected Format: ${selectedFormatInfo}\n` +
          `  Complete Stdout:\n${stdoutData.trim() || '(empty)'}\n` +
          `  Complete Stderr:\n${stderrData.trim() || '(empty)'}`
        );

        const failErr = new PipelineError({
          stage: PipelineStage.DOWNLOAD_FAILED,
          code: classified.type,
          classification: classified,
          message: classified.isAuthIssue
            ? classified.userMessage
            : `Failed to download video from YouTube (exit code ${code}). Selected format: ${selectedFormatInfo}.`,
          exitCode: code,
          signal,
          stderr: stderrData,
          stdout: stdoutData,
          jobId,
        });

        return reject(failErr);
      }

      logger.info(
        `[${jobId}] [DOWNLOAD_SUCCESS] yt-dlp completed successfully in ${elapsedSec}s.\n` +
        `  Exit Code:       ${code}\n` +
        `  Section Trimming: ${sectionRange || 'None'}\n` +
        `  Output Dir:      ${effectiveJobDir}\n` +
        `  Files in Dir:\n  ${fileReport}`
      );

      try {
        // Locate completed source files
        const completedSourceFiles = presentFiles.filter((f) => {
          if (!f.name.startsWith('source.')) return false;
          if (f.name.endsWith('.part') || f.name.endsWith('.ytdl')) return false;
          const ext = path.extname(f.name).toLowerCase();
          return VALID_VIDEO_EXTENSIONS.has(ext) && f.size > 1024; // Ensure non-empty file
        });

        const sourceFile = completedSourceFiles[0];

        if (!sourceFile) {
          const missingMsg = `Completed video file was not found in ${effectiveJobDir}. Directory contains:\n  ${fileReport}`;
          logger.error(`[${jobId}] [DOWNLOAD_FILE_MISSING] ${missingMsg}`);

          throw new PipelineError({
            stage: PipelineStage.DOWNLOAD_FAILED,
            message: `Completed video file was not found after download. Found files: ${presentFiles.map((f) => f.name).join(', ') || 'none'}.`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: stdoutData,
            jobId,
          });
        }

        const sourcePath = path.join(effectiveJobDir, sourceFile.name);

        // Probe media to verify integrity and record performance metrics
        const meta = await probeMedia(sourcePath, jobId);

        // Section 3: Audio stream accounting
        if (meta.audioStreamsCount === 0) {
          logger.error(`[${jobId}] [AUDIO VALIDATION FAILED] Downloaded source contains no audio stream.`);
          throw new PipelineError({
            stage: PipelineStage.DOWNLOAD_FAILED,
            message: 'Downloaded source contains no audio stream.',
            jobId,
          });
        }

        if (meta.audioStreamsCount > 1) {
          logger.warn(
            `\n[AUDIO WARNING]\n` +
            `multiple_audio_streams=true\n` +
            `count=${meta.audioStreamsCount}`
          );
          throw new PipelineError({
            stage: PipelineStage.DOWNLOAD_FAILED,
            message: `Source contains ${meta.audioStreamsCount} audio tracks. Multiple audio tracks cannot be processed without making an application-level audio selection decision.`,
            jobId,
          });
        }

        if (meta.audioStreamsCount === 1) {
          logger.info(
            `\n[AUDIO]\n` +
            `streams=1\n` +
            `codec=${meta.audioCodec}\n` +
            `NO_AUDIO_TRANSFORMATION=true`
          );
        }

        logger.info(`\n[YT-DLP MERGE]\naudio_reencoded=false`);
        await traceAudioStage('SOURCE', sourcePath, jobId);
        const throughputMBs = Number(elapsedSec) > 0 ? (meta.bytes / (1024 * 1024) / Number(elapsedSec)).toFixed(2) : '0.00';

        const downloadMetrics = {
          requestedDurationSec: requestedDuration,
          mode: sectionRange ? 'SECTION' : 'FULL_SOURCE',
          format: selectedFormatInfo,
          videoCodec: meta.videoCodec,
          audioCodec: meta.audioCodec,
          resolution: `${meta.width}x${meta.height}`,
          fps: meta.fps,
          fileSizeMB: meta.fileSizeMB,
          bytes: meta.bytes,
          durationSec: meta.duration,
          elapsedSec: Number(elapsedSec),
          throughputMBs,
        };

        logger.info(
          `[${jobId}] [DOWNLOAD_METRICS]\n` +
          `  REQUESTED=${requestedDuration ? requestedDuration + 's' : 'FULL'}\n` +
          `  MODE=${downloadMetrics.mode}\n` +
          `  FORMAT=${downloadMetrics.format}\n` +
          `  VIDEO=${downloadMetrics.videoCodec} ${downloadMetrics.resolution}@${downloadMetrics.fps}fps\n` +
          `  AUDIO=${downloadMetrics.audioCodec}\n` +
          `  DOWNLOAD=${downloadMetrics.fileSizeMB}MB (${downloadMetrics.bytes} bytes)\n` +
          `  DURATION=${downloadMetrics.durationSec}s\n` +
          `  TIME=${downloadMetrics.elapsedSec}s\n` +
          `  THROUGHPUT=${downloadMetrics.throughputMBs}MB/s`
        );

        logger.info(
          `[${jobId}] [DOWNLOAD_VERIFIED] Source file verified: ${sourceFile.name} ` +
          `(${sourceFile.sizeMB} MB) | ${meta.width}x${meta.height}@${meta.fps}fps | Duration: ${meta.duration}s | SectionRange: ${sectionRange || 'None'}`
        );

        resolve({
          sourcePath,
          filename: sourceFile.name,
          metadata: meta,
          downloadMetrics,
          formatDecision,
        });
      } catch (err) {
        if (err instanceof PipelineError) {
          return reject(err);
        }
        logger.error(`[${jobId}] [DOWNLOAD_INSPECT_ERROR] Error locating/probing downloaded file:`, err.message);
        reject(
          new PipelineError({
            stage: PipelineStage.DOWNLOAD_FAILED,
            message: `Error verifying downloaded file: ${err.message}`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: stdoutData,
            jobId,
            cause: err,
          })
        );
      }
    });
  });
}

/**
 * Downloads a YouTube video at maximum practical quality with smart section downloading
 * and automatic full-source fallback.
 *
 * Tier 1: Attempts exact section download (`*${startTime}-${endTime}`) to minimize bandwidth.
 * Tier 2: If exact section downloading fails, falls back automatically to full-source download.
 *
 * @param {object} options
 * @param {string} options.url - YouTube video URL
 * @param {string} [options.jobDir] - Job directory
 * @param {string} [options.outputDir] - Job directory alias
 * @param {string} options.jobId - Unique job identifier
 * @param {string} [options.startTime] - Start timestamp (MM:SS or HH:MM:SS)
 * @param {string} [options.endTime] - End timestamp (MM:SS or HH:MM:SS)
 * @param {number} [options.stallTimeoutMs] - Watchdog stall limit
 * @param {number} [options.maxDurationMs] - Hard maximum limit
 * @returns {Promise<{ sourcePath: string, filename: string, isSourceTrimmed: boolean, metadata?: object, downloadMetrics?: object }>}
 */
export async function downloadYouTubeVideo({
  url,
  jobDir,
  outputDir,
  jobId,
  startTime = null,
  endTime = null,
  stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
  maxDurationMs = MAX_JOB_DURATION_MS,
}) {
  const effectiveJobDir = jobDir || outputDir;
  if (!effectiveJobDir) {
    throw new Error('downloadYouTubeVideo requires jobDir or outputDir');
  }
  const outputTemplate = path.join(effectiveJobDir, 'source.%(ext)s');

  // Clean up any stale files from previous attempts in job directory
  try {
    const existingFiles = await fs.readdir(effectiveJobDir);
    for (const file of existingFiles) {
      if (file.startsWith('source.')) {
        await fs.unlink(path.join(effectiveJobDir, file)).catch(() => {});
      }
    }
  } catch {}

  const startSec = parseTimestampToSeconds(startTime);
  const endSec = parseTimestampToSeconds(endTime);
  const hasValidRange = startSec !== null && endSec !== null && endSec > startSec;
  const sectionDuration = hasValidRange ? endSec - startSec : null;
  const sectionRange = hasValidRange ? `*${startSec}-${endSec}` : null;
  const sanitizedUrl = sanitizeUrl(url);

  // Section 3 & 4: Inspect available formats before starting download
  const targetMaxHeight = config.outputQualityMode === 'maximum' ? 2160 : 1080;
  const formatDecision = await inspectAndSelectFormats({
    url,
    jobId,
    targetMaxHeight,
  });

  if (hasValidRange) {
    logger.info(
      `[${jobId}] [SECTION_DOWNLOAD_REQUESTED]\n` +
      `  requestedStart:    ${startTime} (${startSec}s)\n` +
      `  requestedEnd:      ${endTime} (${endSec}s)\n` +
      `  requestedDuration: ${sectionDuration}s\n` +
      `  url:               ${sanitizedUrl}\n` +
      `  formatSelector:    ${formatDecision.formatSelector}`
    );

    // Tier 1: Try exact section download
    try {
      const result = await executeYtDlpDownload({
        url,
        effectiveJobDir,
        outputTemplate,
        sectionRange,
        jobId,
        stallTimeoutMs,
        maxDurationMs,
        requestedDuration: sectionDuration,
        formatSelector: formatDecision.formatSelector,
        formatDecision,
      });

      const downloadedDuration = Number(result.metadata?.duration || 0);
      const isRangePass = downloadedDuration > 0 && downloadedDuration <= Math.max(sectionDuration * 2.5, sectionDuration + 10);

      logger.info(
        `\n[RANGE CHECK]\n` +
        `requested_duration=${sectionDuration.toFixed(1)}s\n` +
        `downloaded_duration=${downloadedDuration.toFixed(1)}s\n` +
        `range_mode=true\n` +
        `status=${isRangePass ? 'PASS' : 'FAIL'}\n`
      );

      // Section 10: Fail fast if actual duration is massive (e.g. 38 minutes instead of 20 seconds)
      if (!isRangePass && downloadedDuration > Math.max(60, sectionDuration * 3)) {
        throw new Error(
          `Range download duration check failed: requested ${sectionDuration.toFixed(1)}s but got ${downloadedDuration.toFixed(1)}s (exceeded limit).`
        );
      }

      logger.info(
        `[${jobId}] [RANGE]\n` +
        `requested=${startTime}-${endTime}\n` +
        `duration=${sectionDuration.toFixed(1)}s\n` +
        `downloaded=${result.downloadMetrics?.fileSizeMB || '0.00'} MB\n` +
        `time=${result.downloadMetrics?.elapsedSec || '0.00'}s\n` +
        `throughput=${result.downloadMetrics?.throughputMBs || '0.00'} MB/s`
      );

      logger.info(
        `[${jobId}] [SECTION_DOWNLOAD_SUCCESS]\n` +
        `  SECTION_DOWNLOAD_USED=true\n` +
        `  SECTION_FALLBACK=false\n` +
        `  requestedStart=${startTime}\n` +
        `  requestedEnd=${endTime}\n` +
        `  requestedDuration=${sectionDuration}s\n` +
        `  downloadedDuration=${downloadedDuration}s\n` +
        `  fileSizeMB=${result.downloadMetrics?.fileSizeMB || 'unknown'}MB\n` +
        `  rangeStatus=${isRangePass ? 'PASS' : 'FAIL'}`
      );

      return {
        sourcePath: result.sourcePath,
        filename: result.filename,
        isSourceTrimmed: true,
        metadata: result.metadata,
        downloadMetrics: result.downloadMetrics,
        formatDecision: result.formatDecision || formatDecision,
        rangeStatus: isRangePass ? 'PASS' : 'FAIL',
      };
    } catch (sectionError) {
      const classified = classifyDownloadError(
        sectionError.stderr || '',
        sectionError.stdout || '',
        sectionError
      );

      // Automatic fallback 1: Bot verification challenges or 429 rate limit - retry section download with mobile player clients
      if (classified.type === DownloadErrorType.BOT_VERIFICATION_REQUIRED || sectionError.stderr?.includes('429')) {
        logger.warn(
          `[${jobId}] [BOT_CHALLENGE_DOWNLOAD_RETRY] Web client download blocked by anti-bot verification. Automatically retrying section download with mobile player clients (ios, android, tv)...`
        );
        try {
          const mobileResult = await executeYtDlpDownload({
            url,
            effectiveJobDir,
            outputTemplate,
            sectionRange,
            jobId,
            stallTimeoutMs,
            maxDurationMs,
            requestedDuration: sectionDuration,
            formatSelector: 'bestvideo[height<=1080]+bestaudio/best',
            formatDecision,
            forceMobile: true,
          });

          const downloadedDuration = Number(mobileResult.metadata?.duration || 0);
          const isRangePass = downloadedDuration > 0 && downloadedDuration <= Math.max(sectionDuration * 2.5, sectionDuration + 10);

          logger.info(`[${jobId}] [BOT_CHALLENGE_RETRY_SUCCESS] Mobile player client download succeeded without bot challenge!`);

          return {
            sourcePath: mobileResult.sourcePath,
            filename: mobileResult.filename,
            isSourceTrimmed: true,
            metadata: mobileResult.metadata,
            downloadMetrics: mobileResult.downloadMetrics,
            formatDecision: mobileResult.formatDecision || formatDecision,
            rangeStatus: isRangePass ? 'PASS' : 'FAIL',
          };
        } catch (mobileErr) {
          logger.error(`[${jobId}] Mobile player client fallback section download also failed: ${mobileErr.message}`);
        }
      }

      // Automatic fallback 2: Stream connection/FFmpeg/network glitches - retry section download with resilient format
      if (classified.type === DownloadErrorType.NETWORK_ERROR || classified.type === DownloadErrorType.FFMPEG_ERROR) {
        logger.warn(
          `[${jobId}] [NETWORK_RETRY_DOWNLOAD] Section download encountered transient stream error (${classified.type}). Retrying section download with resilient format...`
        );
        try {
          const retryResult = await executeYtDlpDownload({
            url,
            effectiveJobDir,
            outputTemplate,
            sectionRange,
            jobId,
            stallTimeoutMs,
            maxDurationMs,
            requestedDuration: sectionDuration,
            formatSelector: 'bestvideo[height<=1080]+bestaudio/best',
            formatDecision,
            forceMobile: true,
          });

          const downloadedDuration = Number(retryResult.metadata?.duration || 0);
          const isRangePass = downloadedDuration > 0 && downloadedDuration <= Math.max(sectionDuration * 2.5, sectionDuration + 10);

          logger.info(`[${jobId}] [NETWORK_RETRY_SUCCESS] Resilient section download retry succeeded!`);

          return {
            sourcePath: retryResult.sourcePath,
            filename: retryResult.filename,
            isSourceTrimmed: true,
            metadata: retryResult.metadata,
            downloadMetrics: retryResult.downloadMetrics,
            formatDecision: retryResult.formatDecision || formatDecision,
            rangeStatus: isRangePass ? 'PASS' : 'FAIL',
          };
        } catch (retryErr) {
          logger.error(`[${jobId}] Resilient section download retry also failed: ${retryErr.message}`);
        }
      }

      // Protection: if this is a range request and the source video is longer than 180s (3 minutes),
      // NEVER execute a full-source download! That causes multi-gigabyte downloads and 15-minute timeouts.
      const totalDuration = Number(formatDecision?.totalDuration || 0);
      if (hasValidRange && (totalDuration > 180 || totalDuration === 0)) {
        logger.error(
          `[${jobId}] [SECTION_DOWNLOAD_FULL_FALLBACK_BLOCKED]\n` +
          `  requestedRange=${startTime}-${endTime} (${sectionDuration}s)\n` +
          `  totalSourceDuration=${totalDuration}s\n` +
          `  action=Full-source download blocked to prevent downloading multi-gigabyte entire video.`
        );

        throw new PipelineError({
          stage: PipelineStage.DOWNLOAD_FAILED,
          code: classified.type,
          classification: classified,
          message: `Unable to download the requested clip segment (${startTime} - ${endTime}). Full video download was skipped because source video is too long (${Math.round(totalDuration || 0)}s).`,
          jobId,
          cause: sectionError,
        });
      }

      // If the failure is non-recoverable (e.g. YouTube bot verification, age lock, or private video),
      // DO NOT blindly execute a futile full-source download!
      if (!isRecoverableViaFullDownload(classified)) {
        logger.error(
          `[${jobId}] [SECTION_DOWNLOAD_FATAL_ERROR]\n` +
          `  error_type=${classified.type}\n` +
          `  is_auth_issue=${classified.isAuthIssue}\n` +
          `  recoverable_via_fallback=false\n` +
          `  reason=${classified.developerNote}\n` +
          `  action=Failing fast to prevent redundant blocked requests to YouTube`
        );

        throw new PipelineError({
          stage: PipelineStage.DOWNLOAD_FAILED,
          code: classified.type,
          classification: classified,
          message: classified.userMessage,
          exitCode: sectionError.exitCode ?? null,
          signal: sectionError.signal ?? null,
          stderr: sectionError.stderr ?? '',
          stdout: sectionError.stdout ?? '',
          jobId,
          cause: sectionError,
        });
      }

      logger.warn(
        `[${jobId}] [SECTION_DOWNLOAD_FALLBACK]\n` +
        `  SECTION_DOWNLOAD_USED=false\n` +
        `  SECTION_FALLBACK=true\n` +
        `  requestedStart=${startTime}\n` +
        `  requestedEnd=${endTime}\n` +
        `  requestedDuration=${sectionDuration}s\n` +
        `  reason=${sectionError.message}\n` +
        `  action=Downloading full source fallback; will immediately trim via stream-copy before heavy processing`
      );

      // Clean up any partial files from the failed section attempt
      try {
        const files = await fs.readdir(effectiveJobDir);
        for (const file of files) {
          await fs.unlink(path.join(effectiveJobDir, file)).catch(() => {});
        }
      } catch {}

      // Tier 2: Fall back to full-source download (only for short videos <= 180s)
      const fallbackResult = await executeYtDlpDownload({
        url,
        effectiveJobDir,
        outputTemplate,
        sectionRange: null,
        jobId,
        stallTimeoutMs,
        maxDurationMs,
        requestedDuration: null,
        formatSelector: formatDecision.formatSelector,
        formatDecision,
      });

      logger.info(
        `[${jobId}] [RANGE]\n` +
        `requested=${startTime}-${endTime}\n` +
        `duration=${sectionDuration.toFixed(1)}s\n` +
        `downloaded=${fallbackResult.downloadMetrics?.fileSizeMB || '0.00'} MB\n` +
        `time=${fallbackResult.downloadMetrics?.elapsedSec || '0.00'}s\n` +
        `throughput=${fallbackResult.downloadMetrics?.throughputMBs || '0.00'} MB/s\n` +
        `note=Full source downloaded via fallback, pending immediate stream-level trim`
      );

      logger.info(
        `[${jobId}] [FULL_SOURCE_DOWNLOAD_SUCCESS]\n` +
        `  SECTION_DOWNLOAD_USED=false\n` +
        `  SECTION_FALLBACK=true\n` +
        `  requestedStart=${startTime}\n` +
        `  requestedEnd=${endTime}\n` +
        `  requestedDuration=${sectionDuration}s\n` +
        `  fileSizeMB=${fallbackResult.downloadMetrics?.fileSizeMB || 'unknown'}MB`
      );

      return {
        sourcePath: fallbackResult.sourcePath,
        filename: fallbackResult.filename,
        isSourceTrimmed: false,
        metadata: fallbackResult.metadata,
        downloadMetrics: fallbackResult.downloadMetrics,
      };
    }
  }

  // No range specified: Full download
  logger.info(
    `[${jobId}] [FULL_SOURCE_DOWNLOAD_REQUESTED] whether section download was actually used: false | ` +
    `whether full-source fallback occurred: false`
  );

  const result = await executeYtDlpDownload({
    url,
    effectiveJobDir,
    outputTemplate,
    sectionRange: null,
    jobId,
    stallTimeoutMs,
    maxDurationMs,
    requestedDuration: null,
  });

  return {
    sourcePath: result.sourcePath,
    filename: result.filename,
    isSourceTrimmed: false,
    metadata: result.metadata,
    downloadMetrics: result.downloadMetrics,
  };
}
