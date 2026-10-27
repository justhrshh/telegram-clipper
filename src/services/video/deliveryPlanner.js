import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/env.js';
import { probeMedia, escapeFfmpegPath } from '../videoProcessor.js';
import { getEncoderCapabilities, invalidateCapabilitiesCache } from './encoderCapabilities.js';
import { getVideoFormat } from '../../config/formats.js';
import { PipelineStage, PipelineError } from '../../utils/errors.js';
import {
  probeAudio,
  logAudioSource,
  resolveAudioPlan,
  logAudioOutput,
  verifyAudioOutput,
} from './audioPreservation.js';

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
 * Executes a single derivative FFmpeg encoding pass from the 4K master.
 *
 * @param {object} params
 * @param {string} params.inputPath - Path to master video
 * @param {string} params.outputPath - Target delivery video path
 * @param {number} params.targetWidth - Target width (e.g. 2160, 1440, 1080)
 * @param {number} params.targetHeight - Target height (e.g. 3840, 2560, 1920)
 * @param {number} [params.maxBitrateKbps] - Optional bitrate ceiling in kbps
 * @param {string} params.jobId - Context job identifier
 * @param {string} [params.tierName='delivery'] - Tier label for logging
 * @returns {Promise<object>} Probed metadata of the generated delivery tier
 */
async function renderDerivativeTier({
  inputPath,
  outputPath,
  targetWidth,
  targetHeight,
  maxBitrateKbps,
  jobId,
  tierName = 'delivery',
}) {
  const caps = await getEncoderCapabilities();
  let selectedEncoder = caps.preferredEncoder;

  const runDerivativePass = async (activeEncoder) => {
    const scaleFlag = activeEncoder === 'libx264' ? 'bicubic' : 'lanczos';
    const filter = `scale=${targetWidth}:${targetHeight}:flags=${scaleFlag},setsar=1`;

    const args = [
      '-i',
      inputPath,
      '-vf',
      filter,
      '-fpsmax',
      '60',
    ];

    if (activeEncoder === 'h264_nvenc') {
      args.push(
        '-c:v',
        'h264_nvenc',
        '-preset',
        config.nvencPreset,
        '-profile:v',
        'high',
        '-spatial-aq',
        '1',
        '-temporal-aq',
        '1',
        '-rc-lookahead',
        '8',
        '-pix_fmt',
        'yuv420p'
      );

      if (maxBitrateKbps && maxBitrateKbps > 0) {
        args.push(
          '-rc:v',
          'vbr',
          '-cq:v',
          '21',
          '-b:v',
          `${maxBitrateKbps}k`,
          '-maxrate',
          `${Math.round(maxBitrateKbps * 1.15)}k`,
          '-bufsize',
          `${Math.round(maxBitrateKbps * 2)}k`
        );
      } else {
        args.push(
          '-rc:v',
          'vbr',
          '-cq:v',
          String(config.nvencCqLevel),
          '-b:v',
          '0'
        );
      }
    } else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        config.x264Preset,
        '-pix_fmt',
        'yuv420p'
      );

      if (maxBitrateKbps && maxBitrateKbps > 0) {
        args.push(
          '-crf',
          '21',
          '-maxrate',
          `${Math.round(maxBitrateKbps * 1.15)}k`,
          '-bufsize',
          `${Math.round(maxBitrateKbps * 2)}k`
        );
      } else {
        args.push(
          '-crf',
          String(config.x264Crf)
        );
      }
    }

    const inputAudio = await probeAudio(inputPath, jobId);
    logAudioSource(inputAudio);

    const audioPlan = resolveAudioPlan(inputAudio, jobId);
    logAudioOutput(audioPlan);

    args.push('-map', '0:v:0');
    if (inputAudio.hasAudio && inputAudio.codec !== 'none') {
      args.push('-map', '0:a:0');
    }

    args.push(
      ...audioPlan.args,
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-y',
      outputPath
    );

    logger.info(`[FFMPEG COMMAND]\nffmpeg ${args.join(' ')}`);

    logger.info(
      `[${jobId}] [DELIVERY_RENDER_START] Tier: ${tierName} (${targetWidth}x${targetHeight}) | ` +
      `Encoder: ${activeEncoder} | MaxBitrate: ${maxBitrateKbps ? `${maxBitrateKbps}k` : 'unconstrained'}`
    );

    const startTimeMs = Date.now();

    await new Promise((resolve, reject) => {
      let stderrData = '';
      let isSettled = false;
      let lastProgressAt = Date.now();

      const proc = spawn('ffmpeg', args, { windowsHide: true });

      const watchdogInterval = setInterval(() => {
        if (isSettled) {
          clearInterval(watchdogInterval);
          return;
        }
        const now = Date.now();
        if (now - lastProgressAt > config.ffmpegStallTimeoutMs) {
          isSettled = true;
          clearInterval(watchdogInterval);
          terminateProcessTree(proc.pid);
          reject(
            new PipelineError({
              stage: PipelineStage.CLIP_FAILED,
              message: `Delivery rendering stalled for tier ${tierName}.`,
              exitCode: null,
              signal: 'SIGKILL',
              stderr: stderrData,
              stdout: '',
              jobId,
            })
          );
        }
      }, 2000);

      proc.stdout.on('data', () => {
        lastProgressAt = Date.now();
      });

      proc.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      proc.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        clearInterval(watchdogInterval);
        reject(err);
      });

      proc.on('close', (code, signal) => {
        if (isSettled) return;
        isSettled = true;
        clearInterval(watchdogInterval);

        if (code !== 0) {
          const pipeErr = new PipelineError({
            stage: PipelineStage.CLIP_FAILED,
            message: `Delivery render failed for ${tierName} (code ${code})`,
            exitCode: code,
            signal,
            stderr: stderrData,
            stdout: '',
            jobId,
          });
          pipeErr.rawStderr = stderrData;
          return reject(pipeErr);
        }

        const elapsedSec = ((Date.now() - startTimeMs) / 1000).toFixed(1);
        logger.info(
          `[${jobId}] [DELIVERY_RENDER_COMPLETE] Tier: ${tierName} completed in ${elapsedSec}s (${activeEncoder}).`
        );
        resolve();
      });
    });

    return { inputAudio, audioPlan };
  };

  let executionInfo;
  try {
    executionInfo = await runDerivativePass(selectedEncoder);
  } catch (err) {
    const errText = String(err.rawStderr || err.stderr || err.message || '');
    if (selectedEncoder === 'h264_nvenc' && (errText.includes('CUDA_ERROR') || errText.includes('no CUDA-capable') || err.exitCode === 2981409195 || err.exitCode === -22)) {
      logger.warn(`[${jobId}] [DELIVERY_NVENC_FALLBACK] Delivery derivative NVENC failed. Retrying with CPU libx264...`);
      invalidateCapabilitiesCache();
      await fs.unlink(outputPath).catch(() => {});
      selectedEncoder = 'libx264';
      executionInfo = await runDerivativePass(selectedEncoder);
    } else {
      throw err;
    }
  }

  // Verify audio preservation on output delivery tier with sample comparison
  await verifyAudioOutput({
    sourceAudioMeta: executionInfo.inputAudio,
    sourcePath: inputPath,
    outputPath,
    audioPlan: executionInfo.audioPlan,
    clipStart: 0,
    clipDuration: 0,
    jobId,
  });

  return await probeMedia(outputPath, jobId);
}

/**
 * Plans and renders the optimal delivery file for Telegram based on the 4K master.
 *
 * Ladder:
 * 0. Direct 4K Master (if <= 48 MB)
 * 1. 4K Delivery Optimization (if target bitrate >= 6000 kbps to preserve crispness)
 * 2. 1440x2560 High-Quality Delivery
 * 3. 1080x1920 High-Quality Delivery
 *
 * @param {object} params
 * @param {string} params.masterPath - Path to master 4K MP4 file
 * @param {object} params.masterMetadata - Probed metadata of master
 * @param {string} params.jobDir - Temp job root directory
 * @param {string} params.jobId - Context job identifier
 * @param {number} params.duration - Clip duration in seconds
 * @param {Function} [params.onProgress] - Optional status progress notification
 * @returns {Promise<{
 *   deliveredPath: string,
 *   tierName: string,
 *   tierId: 'master-4k' | 'optimized-4k' | 'delivery-1440' | 'delivery-1080',
 *   width: number,
 *   height: number,
 *   fps: number,
 *   bytes: number,
 *   fileSizeMB: string,
 *   isMaster: boolean,
 *   deliveredLabel: string
 * }>}
 */
export async function planAndRenderDelivery({
  masterPath,
  masterMetadata,
  jobDir,
  jobId,
  duration,
  ratio = 'vertical',
  masterWidth = null,   // Actual master canvas width (source-aware). Falls back to masterMetadata.width
  masterHeight = null,  // Actual master canvas height (source-aware). Falls back to masterMetadata.height
  onProgress = async () => {},
}) {
  const format = getVideoFormat(ratio);

  // Resolve the actual master canvas dimensions
  const actualMasterWidth  = masterWidth  ?? masterMetadata.width;
  const actualMasterHeight = masterHeight ?? masterMetadata.height;

  // For Local Bot API, the upload ceiling is up to 2000 MB; for hosted API, target 48 MB
  const targetMaxMb = config.telegramLocalApi
    ? Math.min(2000, config.telegramLocalMaxUploadMb || 2000)
    : config.telegramTargetMaxMb; // default 48 MB
  const targetMaxBytes = targetMaxMb * 1024 * 1024;
  const masterBytes = masterMetadata.bytes;

  logger.info(
    `[${jobId}] [DELIVERY_PLANNER] Format: ${format.id} (${format.aspectRatioStr}) | ` +
    `Actual Master Canvas: ${actualMasterWidth}×${actualMasterHeight} | ` +
    `Master File: ${masterMetadata.fileSizeMB} MB (${masterBytes} bytes) | ` +
    `Target Limit: ${targetMaxMb} MB (${targetMaxBytes} bytes) [Local API: ${config.telegramLocalApi}]`
  );

  // Build the delivery ladder: only include tiers at or below the actual master canvas.
  // Tiers above the master canvas would be upscales — wasteful and unnecessary.
  const allTiers = format.deliveryTiers;
  const masterShort = Math.min(actualMasterWidth, actualMasterHeight);

  // Tier 0 is "deliver the master directly". Tiers 1–3 are progressive downscales.
  // Filter out any tier whose short side exceeds the master's short side (would be an upscale).
  const applicableTiers = allTiers.filter((tier, idx) => {
    if (idx === 0) return true; // Always include tier 0 (direct master delivery)
    const tierShort = Math.min(tier.width, tier.height);
    return tierShort <= masterShort;
  });

  const [tier0Def, tier1Def, tier2Def, tier3Def] = applicableTiers;

  logger.info(
    `[${jobId}] [DELIVERY_PLANNER] Applicable delivery tiers (${applicableTiers.length}): ` +
    applicableTiers.map(t => `${t.id}(${t.width}×${t.height})`).join(' → ')
  );

  // LOCAL MODE: Never create derivative renders if within local limit (up to 2000 MB). Always deliver the master directly.
  if (config.telegramLocalApi && masterBytes <= targetMaxBytes) {
    logger.info(
      `[DELIVERY]\n` +
      `mode=LOCAL\n` +
      `master_size=${masterMetadata.fileSizeMB}MB\n` +
      `max_upload=${targetMaxMb}MB\n` +
      `derivative_render=false`
    );
    logger.info(
      `[${jobId}] [DELIVERY_TIER_SELECTED] Mode: LOCAL | Delivering direct master (${masterMetadata.fileSizeMB} MB | ${actualMasterWidth}×${actualMasterHeight}). Derivative renders: 0`
    );
    return {
      deliveredPath: masterPath,
      tierName: tier0Def.label,
      tierId: tier0Def.id,
      width: masterMetadata.width,
      height: masterMetadata.height,
      fps: masterMetadata.fps,
      bytes: masterBytes,
      fileSizeMB: masterMetadata.fileSizeMB,
      isMaster: true,
      deliveredLabel: tier0Def.label,
      derivativeRendersCount: 0,
    };
  }

  // Tier 0: Direct master if within limit (HOSTED mode: <= 48 MB)
  if (masterBytes <= targetMaxBytes) {
    logger.info(
      `[${jobId}] [DELIVERY_TIER_SELECTED] Tier: ${tier0Def.id} | Direct master delivered (${masterMetadata.fileSizeMB} MB | ${actualMasterWidth}×${actualMasterHeight})`
    );
    return {
      deliveredPath: masterPath,
      tierName: tier0Def.label,
      tierId: tier0Def.id,
      width: masterMetadata.width,
      height: masterMetadata.height,
      fps: masterMetadata.fps,
      bytes: masterBytes,
      fileSizeMB: masterMetadata.fileSizeMB,
      isMaster: true,
      deliveredLabel: tier0Def.label,
      derivativeRendersCount: 0,
    };
  }

  // Master exceeds target limit → prepare delivery directory
  const deliveryDir = path.join(jobDir, 'delivery');
  await fs.mkdir(deliveryDir, { recursive: true });

  const safeDuration = Math.max(1, duration);
  // Reserve 192 kbps for audio
  const availableBitsForVideo = (targetMaxMb * 8 * 1024 * 1024) - (192 * 1024 * safeDuration);
  const targetBitrateKbps = Math.max(1500, Math.floor(availableBitsForVideo / (safeDuration * 1000)));

  logger.info(
    `[${jobId}] [DELIVERY_BUDGET] Clip Duration: ${safeDuration}s | ` +
    `Calculated Target Video Bitrate: ${targetBitrateKbps} kbps to stay under ${targetMaxMb} MB`
  );

  // Tier 1: Same-resolution optimized delivery (bitrate-capped re-encode of master)
  if (tier1Def && targetBitrateKbps >= 4000) {
    await onProgress('DELIVERY_OPTIMIZING', `⚡ Optimizing ${tier1Def.width}×${tier1Def.height} master for Telegram delivery...`);
    const deliveryTier1Path = path.join(deliveryDir, 'delivery-tier1.mp4');

    try {
      const metaTier1 = await renderDerivativeTier({
        inputPath: masterPath,
        outputPath: deliveryTier1Path,
        targetWidth: tier1Def.width,
        targetHeight: tier1Def.height,
        maxBitrateKbps: targetBitrateKbps,
        jobId,
        tierName: tier1Def.id,
      });

      if (metaTier1.bytes <= targetMaxBytes) {
        logger.info(
          `[${jobId}] [DELIVERY_TIER_SELECTED] Tier: ${tier1Def.id} | Optimized (${metaTier1.fileSizeMB} MB)`
        );
        return {
          deliveredPath: deliveryTier1Path,
          tierName: tier1Def.label,
          tierId: tier1Def.id,
          width: tier1Def.width,
          height: tier1Def.height,
          fps: metaTier1.fps,
          bytes: metaTier1.bytes,
          fileSizeMB: metaTier1.fileSizeMB,
          isMaster: false,
          deliveredLabel: tier1Def.label,
        };
      }
    } catch (err) {
      logger.warn(`[${jobId}] Tier 1 (${tier1Def.id}) failed or oversized: ${err.message}`);
    }
  }

  // Tier 2: One step down from master
  if (tier2Def) {
    await onProgress('DELIVERY_OPTIMIZING', `⚡ Optimizing video to ${tier2Def.width}×${tier2Def.height} for Telegram delivery...`);
    const deliveryTier2Path = path.join(deliveryDir, 'delivery-tier2.mp4');

    try {
      const metaTier2 = await renderDerivativeTier({
        inputPath: masterPath,
        outputPath: deliveryTier2Path,
        targetWidth: tier2Def.width,
        targetHeight: tier2Def.height,
        maxBitrateKbps: targetBitrateKbps,
        jobId,
        tierName: tier2Def.id,
      });

      if (metaTier2.bytes <= targetMaxBytes) {
        logger.info(
          `[${jobId}] [DELIVERY_TIER_SELECTED] Tier: ${tier2Def.id} | ${tier2Def.width}×${tier2Def.height} (${metaTier2.fileSizeMB} MB)`
        );
        return {
          deliveredPath: deliveryTier2Path,
          tierName: tier2Def.label,
          tierId: tier2Def.id,
          width: tier2Def.width,
          height: tier2Def.height,
          fps: metaTier2.fps,
          bytes: metaTier2.bytes,
          fileSizeMB: metaTier2.fileSizeMB,
          isMaster: false,
          deliveredLabel: tier2Def.label,
        };
      }
    } catch (err) {
      logger.warn(`[${jobId}] Tier 2 (${tier2Def.id}) failed or oversized: ${err.message}`);
    }
  }

  // Tier 3: Lowest quality tier (always attempted as fallback)
  const fallbackTierDef = tier3Def || tier2Def || tier1Def || tier0Def;
  await onProgress('DELIVERY_OPTIMIZING', `⚡ Optimizing video to ${fallbackTierDef.width}×${fallbackTierDef.height} for Telegram delivery...`);
  const deliveryFallbackPath = path.join(deliveryDir, 'delivery-fallback.mp4');

  const metaFallback = await renderDerivativeTier({
    inputPath: masterPath,
    outputPath: deliveryFallbackPath,
    targetWidth: fallbackTierDef.width,
    targetHeight: fallbackTierDef.height,
    maxBitrateKbps: Math.min(targetBitrateKbps, 5000),
    jobId,
    tierName: fallbackTierDef.id,
  });

  logger.info(
    `[${jobId}] [DELIVERY_TIER_SELECTED] Tier: ${fallbackTierDef.id} | ${fallbackTierDef.width}×${fallbackTierDef.height} fallback (${metaFallback.fileSizeMB} MB)`
  );

  return {
    deliveredPath: deliveryFallbackPath,
    tierName: fallbackTierDef.label,
    tierId: fallbackTierDef.id,
    width: fallbackTierDef.width,
    height: fallbackTierDef.height,
    fps: metaFallback.fps,
    bytes: metaFallback.bytes,
    fileSizeMB: metaFallback.fileSizeMB,
    isMaster: false,
    deliveredLabel: fallbackTierDef.label,
  };
}

