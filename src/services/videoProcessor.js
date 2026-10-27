import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { PipelineStage, PipelineError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { getEncoderCapabilities, invalidateCapabilitiesCache } from './video/encoderCapabilities.js';
import { getVideoFormat } from '../config/formats.js';
import {
  probeAudio,
  logAudioSource,
  resolveAudioPlan,
  logAudioOutput,
  verifyAudioOutput,
} from './video/audioPreservation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONTS_DIR = path.resolve(__dirname, '../../assets/fonts');

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
 * Forcefully terminates a Windows process tree to ensure no orphan workers linger.
 *
 * @param {number} pid
 */
function terminateProcessTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch (err) {
    logger.warn(`Failed to terminate process tree for PID ${pid}:`, err.message);
  }
}

/**
 * Inspects a media file using ffprobe and extracts comprehensive audio/video specifications.
 *
 * @param {string} filePath - Absolute path to media file
 * @param {string} [jobId='probe'] - Job ID for logging context
 * @returns {Promise<{
 *   width: number,
 *   height: number,
 *   fps: number,
 *   videoCodec: string,
 *   pixelFormat: string,
 *   videoBitrateKbps: number|string,
 *   audioCodec: string,
 *   audioBitrateKbps: number|string,
 *   duration: number,
 *   fileSizeMB: string,
 *   bytes: number
 * }>}
 */
export async function probeMedia(filePath, jobId = 'probe') {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'stream=width,height,r_frame_rate,bit_rate,codec_name,pix_fmt,codec_type,sample_rate,channels,channel_layout,duration:format=duration,size,bit_rate',
    '-of',
    'json',
    filePath,
  ];

  try {
    const rawJson = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('ffprobe', args, { windowsHide: true });
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `ffprobe exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    const parsed = JSON.parse(rawJson);
    const videoStreams = parsed.streams?.filter((s) => s.codec_type === 'video') || [];
    const audioStreams = parsed.streams?.filter((s) => s.codec_type === 'audio') || [];
    const videoStream = videoStreams[0];
    const audioStream = audioStreams[0];
    const format = parsed.format || {};

    let fps = 0;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      fps = den ? Math.round((num / den) * 100) / 100 : 0;
    }

    const stats = await fs.stat(filePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const videoBitrateKbps = videoStream?.bit_rate
      ? Math.round(Number(videoStream.bit_rate) / 1000)
      : format.bit_rate
      ? Math.round(Number(format.bit_rate) / 1000)
      : 'N/A';
    const audioBitrateKbps = audioStream?.bit_rate
      ? Math.round(Number(audioStream.bit_rate) / 1000)
      : '256';

    const audioCodec = audioStream?.codec_name ? audioStream.codec_name.toLowerCase() : 'unknown';
    const audioSampleRate = audioStream?.sample_rate ? String(audioStream.sample_rate) : 'unknown';
    const audioChannels = audioStream?.channels != null ? Number(audioStream.channels) : 0;
    const audioChannelLayout = audioStream?.channel_layout || (audioChannels === 1 ? 'mono' : (audioChannels === 2 ? 'stereo' : 'unknown'));
    const audioDuration = audioStream?.duration ? Number(audioStream.duration) : (format.duration ? Number(format.duration) : 0);
    const audioLanguage = audioStream?.tags?.language || 'default';

    return {
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      fps,
      videoCodec: videoStream?.codec_name || 'unknown',
      pixelFormat: videoStream?.pix_fmt || 'unknown',
      videoBitrateKbps,
      videoStreamsCount: videoStreams.length,
      audioStreamsCount: audioStreams.length,
      audioCodec,
      audioBitrateKbps,
      audioSampleRate,
      audioChannels,
      audioChannelLayout,
      audioDuration,
      audioLanguage,
      duration: Math.round(Number(format.duration || 0)),
      fileSizeMB,
      bytes: stats.size,
    };
  } catch (err) {
    logger.warn(`[${jobId}] Could not probe media metadata:`, err.message);
    const stats = await fs.stat(filePath).catch(() => ({ size: 0 }));
    return {
      width: 0,
      height: 0,
      fps: 30,
      videoCodec: 'unknown',
      pixelFormat: 'unknown',
      videoBitrateKbps: 'N/A',
      videoStreamsCount: 0,
      audioStreamsCount: 0,
      audioCodec: 'unknown',
      audioBitrateKbps: 'N/A',
      duration: 0,
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      bytes: stats.size,
    };
  }
}

/**
 * Creates an exact clip segment from a source video using FFmpeg stream copy.
 * Ensures the resulting file starts at 0:00 and has duration matching the requested range.
 *
 * @param {object} params
 * @param {string} params.sourcePath - Input video path
 * @param {string} params.outputPath - Output clip path
 * @param {number} [params.startSeconds=0] - Seek offset
 * @param {number} params.duration - Requested clip duration
 * @param {string} [params.jobId='clip'] - Job identifier
 * @returns {Promise<string>} outputPath
 */
export async function createExactClip({
  sourcePath,
  outputPath,
  startSeconds = 0,
  duration,
  jobId = 'clip',
}) {
  const sourceAudio = await probeAudio(sourcePath, jobId);
  logAudioSource(sourceAudio);

  const audioPlan = resolveAudioPlan(sourceAudio, jobId);
  logAudioOutput(audioPlan);

  const args = [];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push('-i', sourcePath);
  if (duration > 0) {
    args.push('-t', String(duration));
  }
  args.push('-map', '0:v:0');
  if (sourceAudio.hasAudio && sourceAudio.codec !== 'none') {
    args.push('-map', '0:a:0');
  }
  args.push(
    '-c:v', 'copy',
    ...audioPlan.args,
    '-movflags', '+faststart',
    '-y',
    outputPath
  );

  logger.info(`[FFMPEG COMMAND]\nffmpeg ${args.join(' ')}`);
  logger.info(`[${jobId}] Trimming exact clip (${startSeconds}s -> +${duration}s): ${outputPath}`);

  await new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        logger.error(`[${jobId}] createExactClip failed with code ${code}: ${stderr.slice(-400)}`);
        reject(new Error(`Failed to create exact clip: exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });

  // Verify audio preservation on output with sample-level comparison
  await verifyAudioOutput({
    sourceAudioMeta: sourceAudio,
    sourcePath,
    outputPath,
    audioPlan,
    clipStart: startSeconds,
    clipDuration: duration,
    jobId,
  });

  return outputPath;
}

/**
 * Clips, transforms, and renders video into a 2160x3840 (4K vertical / 9:16) MP4 using FFmpeg.
 *
 * Supports:
 * - Runtime hardware detection: uses NVIDIA NVENC (h264_nvenc) when available, falls back to libx264.
 * - Single-pass subtitle burning if `assPath` is specified.
 * - Structured progress tracking via `-progress pipe:1`.
 * - Active progress watchdog preventing false timeouts during active rendering.
 *
 * @param {object} options
 * @param {string} options.sourcePath - Absolute path to source video
 * @param {string} options.outputPath - Absolute path for output MP4 file
 * @param {number} options.startSeconds - Start time in seconds
 * @param {number} options.endSeconds - End time in seconds
 * @param {string} options.jobId - Unique job identifier for logging
 * @param {boolean} [options.isSourceTrimmed=false] - Whether source is already trimmed to startTime
 * @param {string} [options.assPath] - Optional ASS subtitle path for single-pass caption burning
 * @param {number} [options.stallTimeoutMs] - Inactivity watchdog limit (default from env config)
 * @param {number} [options.maxDurationMs] - Hard ceiling duration limit (default from env config)
 * @param {(progress: object) => void} [options.onEncodingProgress] - Optional hook for live progress
 * @returns {Promise<{
 *   outputPath: string,
 *   duration: number,
 *   metadata: object,
 *   sourceMetadata: object,
 *   encoder: string,
 *   isGpuUsed: boolean
 * }>}
 */
export async function processVerticalClip({
  sourcePath,
  outputPath,
  startSeconds,
  endSeconds,
  jobId,
  isSourceTrimmed = false,
  assPath = null,
  ratio = 'vertical',
  presentation = 'standard',
  targetWidth = null,   // Source-aware override; if null, uses format.master.width
  targetHeight = null,  // Source-aware override; if null, uses format.master.height
  sourceClass = null,   // e.g. 'native-4k' | '1440p' | '1080p' | '720p' (for sourceAware metadata)
  masterClass = null,   // e.g. 'native' | 'upscaled' (for sourceAware metadata)
  stallTimeoutMs = config.ffmpegStallTimeoutMs,
  maxDurationMs = config.ffmpegMaxDurationMs,
  onEncodingProgress = null,
}) {
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const formatConfig = getVideoFormat(ratio);
  // Use caller-supplied dims if provided (source-aware), else fall back to format's 4K master
  const targetW = targetWidth  ?? formatConfig.master.width;
  const targetH = targetHeight ?? formatConfig.master.height;
  const targetRatioStr = `${targetW}/${targetH}`;

  // 1. Audit source media specs before processing
  const sourceMetadata = await probeMedia(sourcePath, jobId);
  logger.info(
    `[${jobId}] Source Video Specs: ${sourceMetadata.width}x${sourceMetadata.height} @ ${sourceMetadata.fps}fps | ` +
    `Codec: ${sourceMetadata.videoCodec} (${sourceMetadata.pixelFormat}) / ${sourceMetadata.audioCodec} | ` +
    `Bitrate: ${sourceMetadata.videoBitrateKbps} kbps | Size: ${sourceMetadata.fileSizeMB} MB | isSourceTrimmed: ${isSourceTrimmed} | targetFormat: ${formatConfig.id} (${targetW}x${targetH}) [presentation: ${presentation}]`
  );

  // 2. Detect hardware encoder (h264_nvenc vs libx264)
  const caps = await getEncoderCapabilities();
  const selectedEncoder = caps.preferredEncoder;
  const isGpuUsed = caps.gpuAvailable;

  logger.info(
    `[${jobId}] [RENDER_PIPELINE] Selected Encoder: ${selectedEncoder} (GPU acceleration: ${isGpuUsed}) | Reason: ${caps.reason}`
  );

  const startTimeMs = Date.now();

  // Inspect source audio stream
  const sourceAudio = await probeAudio(sourcePath, jobId);
  logAudioSource(sourceAudio);

  // Resolve audio plan (preserve source audio with -c:a copy if MP4 compatible)
  const audioPlan = resolveAudioPlan(sourceAudio, jobId);
  logAudioOutput(audioPlan);

  const executeEncode = async (activeEncoder) => {
    const isSquareFocus = presentation === 'square_focus' && ratio === 'vertical';
    const scaleFlag = activeEncoder === 'libx264' ? 'bicubic' : 'lanczos';

    let filterComplex = null;
    let videoFilter = null;

    if (isSquareFocus) {
      const fgW = targetW;
      const fgH = targetW;
      const fgX = 0;
      const fgY = Math.round((targetH - fgH) / 2);

      const blurRadius = config.squareFocusBlur || 30;
      const darkenFactor = (1 - (config.squareFocusDarken || 0.25)).toFixed(2);

      const bgDownW = 540;
      const bgDownH = 960;

      filterComplex =
        `[0:v]split=2[bg_in][fg_in];` +
        `[bg_in]scale=${bgDownW}:${bgDownH}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
        `crop=${bgDownW}:${bgDownH}:(iw-${bgDownW})/2:(ih-${bgDownH})/2,` +
        `boxblur=${blurRadius}:3,` +
        `colorchannelmixer=rr=${darkenFactor}:gg=${darkenFactor}:bb=${darkenFactor},` +
        `scale=${targetW}:${targetH}:flags=bilinear,setsar=1[bg];` +
        `[fg_in]crop='min(iw,ih)':'min(iw,ih)':(iw-out_w)/2:(ih-out_h)/2,` +
        `scale=${fgW}:${fgH}:flags=${scaleFlag},setsar=1[fg];` +
        `[bg][fg]overlay=${fgX}:${fgY}[comp]`;

      if (assPath) {
        const safeAssPath = escapeFfmpegPath(assPath);
        const safeFontsDir = escapeFfmpegPath(FONTS_DIR);
        filterComplex += `;[comp]subtitles='${safeAssPath}':fontsdir='${safeFontsDir}'[outv]`;
        logger.info(`[${jobId}] [SQUARE_FOCUS] Attached kinetic ghost-caption filter to composite`);
      } else {
        filterComplex += `;[comp]null[outv]`;
      }

      logger.info(
        `\n[COMPOSITION]\n` +
        `style=SQUARE_FOCUS\n` +
        `canvas=${targetW}x${targetH}\n` +
        `foreground=${fgW}x${fgH}\n` +
        `foreground_width_percent=100%\n` +
        `foreground_side_margin=0\n` +
        `foreground_vertical_center=true\n` +
        `foreground_y=${fgY}\n` +
        `background=blurred_duplicate\n` +
        `blur=${blurRadius}\n` +
        `darken=${config.squareFocusDarken || 0.25}\n` +
        `single_encode=true\n\n` +
        `[AUDIO]\n` +
        `mode=COPY\n` +
        `processing=false\n\n` +
        `[ENCODER]\n` +
        `${activeEncoder}`
      );
    } else {
      videoFilter =
        `scale=w='if(gt(a,${targetRatioStr}),-2,${targetW})':h='if(gt(a,${targetRatioStr}),${targetH},-2)':flags=${scaleFlag},` +
        `crop=${targetW}:${targetH}:(in_w-${targetW})/2:(in_h-${targetH})/2,setsar=1`;

      if (assPath) {
        const safeAssPath = escapeFfmpegPath(assPath);
        const safeFontsDir = escapeFfmpegPath(FONTS_DIR);
        videoFilter += `,subtitles='${safeAssPath}':fontsdir='${safeFontsDir}'`;
        logger.info(`[${jobId}] Combined ${formatConfig.id} transform + ASS subtitle filter: ${videoFilter}`);
      }
    }

    const args = [];

    if (!isSourceTrimmed && startSeconds > 0) {
      args.push('-ss', String(startSeconds));
    }

    args.push('-i', sourcePath, '-t', String(duration));

    if (isSquareFocus) {
      args.push('-filter_complex', filterComplex, '-map', '[outv]');
    } else {
      args.push('-vf', videoFilter, '-map', '0:v:0');
    }

    args.push('-fpsmax', '60');

    if (activeEncoder === 'h264_nvenc') {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', config.nvencPreset,
        '-rc:v', 'vbr',
        '-cq:v', String(config.nvencCqLevel),
        '-b:v', '0',
        '-profile:v', 'high',
        '-spatial-aq', '1',
        '-temporal-aq', '1',
        '-rc-lookahead', '8',
        '-pix_fmt', 'yuv420p'
      );
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', config.x264Preset,
        '-crf', String(config.x264Crf),
        '-pix_fmt', 'yuv420p'
      );
    }

    if (sourceAudio.hasAudio && sourceAudio.codec !== 'none') {
      args.push('-map', '0:a:0');
    }

    args.push(...audioPlan.args);

    args.push(
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-y',
      outputPath
    );

    logger.info(`[FFMPEG COMMAND]\nffmpeg ${args.join(' ')}`);

    logger.info(
      `[ENCODER ACTUAL]\n` +
      `video_encoder=${activeEncoder}\n` +
      `hardware_path=${activeEncoder === 'h264_nvenc'}`
    );

    return new Promise((resolve, reject) => {
      let stderrData = '';
      let isSettled = false;
      let lastProgressAt = Date.now();
      let lastLoggedProgressAt = 0;
      const progressData = {};

      const proc = spawn('ffmpeg', args, { windowsHide: true });

      const watchdogInterval = setInterval(() => {
        if (isSettled) {
          clearInterval(watchdogInterval);
          return;
        }

        const now = Date.now();
        const inactiveMs = now - lastProgressAt;
        const totalElapsedMs = now - startTimeMs;

        if (inactiveMs > stallTimeoutMs) {
          isSettled = true;
          clearInterval(watchdogInterval);
          const stallSec = (inactiveMs / 1000).toFixed(1);
          const totalSec = (totalElapsedMs / 1000).toFixed(1);

          logger.error(
            `[${jobId}] [FFMPEG_STALL] FFmpeg encoder stalled! No progress for ${stallSec}s (limit: ${stallTimeoutMs}ms). Total time: ${totalSec}s.`
          );

          terminateProcessTree(proc.pid);

          reject(
            new PipelineError({
              stage: PipelineStage.CLIP_FAILED,
              message: `FFmpeg processing stalled (no progress for ${stallSec} seconds).`,
              exitCode: null,
              signal: 'SIGKILL',
              stderr: stderrData,
              stdout: '',
              jobId,
            })
          );
          return;
        }

        if (totalElapsedMs > maxDurationMs) {
          isSettled = true;
          clearInterval(watchdogInterval);
          const totalSec = (totalElapsedMs / 1000).toFixed(1);

          logger.error(
            `[${jobId}] [FFMPEG_MAX_DURATION] FFmpeg exceeded hard limit of ${totalSec}s (max: ${maxDurationMs}ms).`
          );

          terminateProcessTree(proc.pid);

          reject(
            new PipelineError({
              stage: PipelineStage.CLIP_FAILED,
              message: `FFmpeg processing exceeded maximum allowed duration of ${Math.round(maxDurationMs / 1000)} seconds.`,
              exitCode: null,
              signal: 'SIGKILL',
              stderr: stderrData,
              stdout: '',
              jobId,
            })
          );
        }
      }, 2000);

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.split(/[\r\n]+/);

        for (const line of lines) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            const key = line.slice(0, eqIdx).trim();
            const val = line.slice(eqIdx + 1).trim();
            progressData[key] = val;
            lastProgressAt = Date.now();

            if (key === 'progress') {
              const now = Date.now();
              if (now - lastLoggedProgressAt >= 3000) {
                lastLoggedProgressAt = now;
                const curTime = progressData.out_time ? progressData.out_time.slice(0, 8) : 'N/A';
                const curFps = progressData.fps || 'N/A';
                const curSpeed = progressData.speed || 'N/A';
                const curSize = progressData.total_size
                  ? `${(Number(progressData.total_size) / (1024 * 1024)).toFixed(1)} MB`
                  : 'N/A';

                logger.info(
                  `[${jobId}] [FFMPEG_PROGRESS] Time: ${curTime} | FPS: ${curFps} | Speed: ${curSpeed} | Output: ${curSize} | Target: ${targetW}x${targetH} (${formatConfig.id})`
                );

                if (typeof onEncodingProgress === 'function') {
                  try {
                    onEncodingProgress({ ...progressData });
                  } catch {}
                }
              }
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      proc.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        clearInterval(watchdogInterval);
        logger.error(`[${jobId}] [CLIP_SPAWN_ERROR] Failed to spawn ffmpeg:`, err.message);
        reject(
          new PipelineError({
            stage: PipelineStage.CLIP_FAILED,
            message: `Failed to start FFmpeg: ${err.message}`,
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
        clearInterval(watchdogInterval);

        if (code !== 0) {
          logger.error(
            `[${jobId}] [CLIP_FAILED] FFmpeg exited with code ${code}.\n` +
            `  Stderr:\n${stderrData.trim() || '(empty)'}`
          );
          const clipErr = new PipelineError({
            stage: PipelineStage.CLIP_FAILED,
            message: `Video processing failed (FFmpeg exit code ${code}).`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: '',
            jobId,
          });
          clipErr.rawCode = code;
          clipErr.rawStderr = stderrData;
          return reject(clipErr);
        }

        resolve();
      });
    });
  };

  let activeEncoder = selectedEncoder;
  let activeIsGpu = isGpuUsed;

  try {
    await executeEncode(activeEncoder);
  } catch (err) {
    const errText = String(err.rawStderr || err.stderr || '');
    const isNvencCudaError =
      activeEncoder === 'h264_nvenc' &&
      (
        errText.includes('CUDA_ERROR_NO_DEVICE') ||
        errText.includes('no CUDA-capable device') ||
        errText.includes('Error while opening encoder') ||
        errText.includes('Device creation failed') ||
        errText.includes('Cannot load nvcuda.dll') ||
        err.rawCode === 2981409195 ||
        err.rawCode === -22 ||
        err.exitCode === 2981409195 ||
        err.exitCode === -22
      );

    if (isNvencCudaError) {
      logger.warn(
        `[${jobId}] [NVENC_ENCODER_FALLBACK] NVENC execution failed (${errText.includes('CUDA_ERROR_NO_DEVICE') ? 'CUDA_ERROR_NO_DEVICE' : 'encoder initialization error'}). In-flight fallback to libx264 (CPU)...`
      );
      invalidateCapabilitiesCache();
      await fs.unlink(outputPath).catch(() => {});
      activeEncoder = 'libx264';
      activeIsGpu = false;
      await executeEncode(activeEncoder);
    } else {
      throw err;
    }
  }

  const elapsedSec = ((Date.now() - startTimeMs) / 1000).toFixed(1);
  logger.info(
    `[${jobId}] [CLIP_SUCCESS] FFmpeg ${formatConfig.id} conversion completed in ${elapsedSec}s (${activeEncoder}).`
  );

  // 4. Probe output video to verify all required parameters
  const metadata = await probeMedia(outputPath, jobId);

  const masterIsUpscaled = Boolean(
    sourceMetadata.width > 0 &&
    (sourceMetadata.width < targetW || sourceMetadata.height < targetH)
  );

  const sourceAware = {
    sourceWidth: sourceMetadata.width,
    sourceHeight: sourceMetadata.height,
    sourceFps: sourceMetadata.fps,
    sourceCodec: sourceMetadata.videoCodec,
    sourceClass: sourceClass || 'unknown',
    masterWidth: metadata.width,
    masterHeight: metadata.height,
    masterFps: metadata.fps,
    masterRatio: formatConfig.id,
    masterClass: masterClass || (masterIsUpscaled ? 'upscaled' : 'native'),
    masterIsUpscaled,
  };

  logger.info(
    `[${jobId}] Final Master Output Audit: ${metadata.width}x${metadata.height} (${formatConfig.id}) @ ${metadata.fps}fps | ` +
    `Codec: ${metadata.videoCodec} (${metadata.pixelFormat}) / ${metadata.audioCodec} (${metadata.audioBitrateKbps} kbps) | ` +
    `Video Bitrate: ${metadata.videoBitrateKbps} kbps | Size: ${metadata.fileSizeMB} MB | Duration: ${metadata.duration}s | ` +
    `Encoder: ${selectedEncoder} | isGpuUsed: ${isGpuUsed}`
  );

  logger.info(
    `[${jobId}] [SOURCE_AWARE_METADATA] Source: ${sourceAware.sourceWidth}x${sourceAware.sourceHeight} @ ${sourceAware.sourceFps}fps (${sourceAware.sourceCodec}) | ` +
    `Master: ${sourceAware.masterWidth}x${sourceAware.masterHeight} (${sourceAware.masterRatio}) @ ${sourceAware.masterFps}fps | ` +
    `masterIsUpscaled: ${sourceAware.masterIsUpscaled}`
  );

  // 5. Verify audio preservation on output with sample-level comparison
  const audioVerification = await verifyAudioOutput({
    sourceAudioMeta: sourceAudio,
    sourcePath,
    outputPath,
    audioPlan,
    clipStart: isSourceTrimmed ? 0 : startSeconds,
    clipDuration: duration,
    jobId,
  });

  return {
    outputPath,
    duration,
    metadata,
    sourceMetadata,
    sourceAware,
    encoder: activeEncoder,
    isGpuUsed: activeIsGpu,
    audioVerification,
  };
}

export const processVideoClip = processVerticalClip;

