import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { downloadYouTubeVideo } from './youtubeDownloader.js';
import { processVerticalClip, probeMedia, createExactClip } from './videoProcessor.js';
import { planAndRenderDelivery } from './video/deliveryPlanner.js';
import { classifySource } from './video/sourceClassifier.js';
import {
  MP4_COMPATIBLE_AUDIO_CODECS,
  traceAudioStage,
  printOriginalAudioForensics,
  logAudioPolicy,
  validatePassiveAudioCopy,
} from './video/audioPreservation.js';
import { alignSourceMedia } from './video/mediaAligner.js';
import { parseTimestampToSeconds } from '../utils/validator.js';
import { logger } from '../utils/logger.js';
import { PipelineStage, PipelineError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { getVideoFormat } from '../config/formats.js';
import { scheduler } from '../jobs/scheduler.js';
import { extractAudioFromClip, transcribeAudio } from './transcription/transcriptionService.js';
import { generateCaptionAss } from './captions/captionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_ROOT = path.resolve(__dirname, '../../temp');

/**
 * Ensures the root temp directory exists.
 */
async function ensureTempRoot() {
  try {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
  } catch (err) {
    logger.error('Failed to create temp root directory:', err);
  }
}

/**
 * Safely removes a job's temporary directory.
 *
 * @param {string} jobDir - Directory to remove
 * @param {string} jobId - Job ID for logging context
 */
async function cleanupJobDirectory(jobDir, jobId) {
  try {
    await fs.rm(jobDir, { recursive: true, force: true });
    logger.info(`[${jobId}] Cleaned up temporary directory: ${jobDir}`);
  } catch (err) {
    logger.warn(`[${jobId}] Failed to clean up temp dir ${jobDir}:`, err.message);
  }
}

/**
 * Executes the production 4K Vertical Clipper pipeline.
 *
 * Optimized Workflow:
 * 1. Validates inputs and timestamps.
 * 2. Downloads video with smart section slicing (Tier 1 exact range, Tier 2 full-source fallback).
 * 3. If Captions = NO:
 *    - Single-pass 4K vertical transform (2160x3840 @ source FPS) with NVENC / optimized libx264.
 * 4. If Captions = YES:
 *    - Extracts audio directly from source file (0.2s).
 *    - Transcribes with faster-whisper and generates 4K kinetic ASS subtitles.
 *    - Executes SINGLE-PASS 4K vertical transform with burned-in ASS subtitles (eliminates redundant 4K encode).
 * 5. Gathers metadata and returns result with cleanup hook.
 *
 * @param {object} params
 * @param {string} params.url - YouTube URL
 * @param {string} params.startTime - Start timestamp (MM:SS or HH:MM:SS)
 * @param {string} params.endTime - End timestamp (MM:SS or HH:MM:SS)
 * @param {boolean} [params.captions=false] - Whether captions are requested
 * @param {string} [params.captionStyle='podcast-pro'] - Caption style preset ID
 * @param {string|number} [params.userId='unknown'] - Telegram user ID
 * @param {string} [params.jobId] - Custom job ID
 * @param {(stage: string, message: string) => Promise<void>} [onProgress] - Progress notification hook
 * @returns {Promise<{
 *   jobId: string,
 *   outputPath: string,
 *   duration: number,
 *   metadata: object,
 *   sourceMetadata: object,
 *   transcript?: object,
 *   style?: object,
 *   encoder: string,
 *   isGpuUsed: boolean,
 *   cleanup: () => Promise<void>
 * }>}
 */
export async function processClipJob(
  { url, startTime, endTime, ratio = 'vertical', presentation = 'standard', captions = false, captionStyle = 'podcast-pro', captionConfig = null, userId = 'unknown', jobId: customJobId },
  onProgress = async () => {}
) {
  const jobId = customJobId || crypto.randomUUID();
  const startTimeMs = Date.now();
  const format = getVideoFormat(ratio);

  logger.info(
    `[${jobId}] Processing clip job initiated for user ${userId}: ${url} [${startTime} -> ${endTime}] [format: ${format.id} (${format.aspectRatioStr})] [presentation: ${presentation}] (captions: ${captions ? captionStyle : 'NO'})`
  );

  // 1. Validation check
  if (!url) {
    throw new PipelineError({
      stage: PipelineStage.DOWNLOAD_FAILED,
      message: 'Missing YouTube video URL.',
      jobId,
    });
  }

  const startSeconds = parseTimestampToSeconds(startTime);
  const endSeconds = parseTimestampToSeconds(endTime);

  if (startSeconds === null || endSeconds === null) {
    throw new PipelineError({
      stage: PipelineStage.CLIP_FAILED,
      message: 'Invalid timestamp format. Expected MM:SS or HH:MM:SS.',
      jobId,
    });
  }

  if (endSeconds <= startSeconds) {
    throw new PipelineError({
      stage: PipelineStage.CLIP_FAILED,
      message: `End timestamp (${endTime}) must be greater than start timestamp (${startTime}).`,
      jobId,
    });
  }

  const clipDuration = endSeconds - startSeconds;

  // 2. Prepare isolated job directory
  await ensureTempRoot();
  const jobDir = path.join(TEMP_ROOT, 'jobs', jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const masterVideoPath = path.join(jobDir, 'master.mp4');

  const cleanup = async () => {
    await cleanupJobDirectory(jobDir, jobId);
  };

  const stageTimings = {};
  const recordStage = (name, start, end) => {
    const durationMs = end - start;
    const durationSec = (durationMs / 1000).toFixed(1);
    stageTimings[name] = { start, end, durationMs, durationSec };
    logger.info(`[${jobId}] [STAGE_TIMING] ${name}: ${durationSec}s (${durationMs}ms) [start: ${start}, end: ${end}]`);
  };

  try {
    // Stage 0: Log Active Media & Passive Audio Policies
    logAudioPolicy();

    // Stage 1: YouTube Download (Smart Section Optimized)
    await onProgress('DOWNLOADING', '⬇️ Downloading video (fetching highest quality segment)...');
    logger.info(`[${jobId}] Stage 1: Starting YouTube download for range [${startTime} -> ${endTime}]...`);

    const releaseDownload = await scheduler.acquireDownloadSlot(
      jobId,
      userId,
      (pos) => onProgress('QUEUED', `⏳ Queued for download (position #${pos})...`)
    );

    let downloadResult;
    const tDownStart = Date.now();
    try {
      downloadResult = await downloadYouTubeVideo({
        url,
        jobDir,
        jobId,
        startTime,
        endTime,
      });
    } finally {
      releaseDownload();
    }
    const { sourcePath, isSourceTrimmed, metadata: sourceMeta, formatDecision } = downloadResult;
    recordStage('DOWNLOAD', tDownStart, Date.now());

    // Step 1.4: SECTION ALIGNMENT — trim pre-roll so requestedStart corresponds to 0:00 for both video and audio
    const tAlignStart = Date.now();
    const alignmentResult = await alignSourceMedia({
      sourcePath,
      jobDir,
      jobId,
      startTime,
      endTime,
      clipDuration,
      isSourceTrimmed,
    });
    const effectiveSourcePath = alignmentResult.alignedSourcePath;
    recordStage('ALIGNMENT', tAlignStart, Date.now());

    // Step 1.5: Determine whether visual transformation is required
    const probedSourceMeta = await probeMedia(effectiveSourcePath, jobId);

    if (probedSourceMeta.audioStreamsCount > 1) {
      logger.warn(
        `\n[AUDIO WARNING]\n` +
        `multiple_audio_streams=true\n` +
        `count=${probedSourceMeta.audioStreamsCount}`
      );
      throw new PipelineError({
        stage: PipelineStage.CLIP_FAILED,
        message: `Source contains ${probedSourceMeta.audioStreamsCount} audio tracks. Multiple audio tracks cannot be processed without making an application-level audio selection decision.`,
        jobId,
      });
    }

    const sourceDuration = probedSourceMeta?.duration || 0;
    const durationDelta = Math.abs(sourceDuration - clipDuration);
    const sectionIsExact = isSourceTrimmed && durationDelta <= 1.5;

    // Step 1.6: SOURCE CLASSIFICATION — determine render canvas
    const sourceClassification = classifySource({
      width:       probedSourceMeta.width  || 0,
      height:      probedSourceMeta.height || 0,
      ratio,
      qualityMode: config.outputQualityMode,
      jobId,
    });
    const { masterWidth, masterHeight } = sourceClassification;

    const sourceAspect = (probedSourceMeta.width > 0 && probedSourceMeta.height > 0)
      ? probedSourceMeta.width / probedSourceMeta.height
      : 0;
    const targetAspect = format.aspectRatio;
    const aspectDelta = Math.abs(sourceAspect - targetAspect);
    const isAspectMatch = aspectDelta < 0.05;
    const isCodecCompatible = probedSourceMeta.videoCodec === 'h264' && MP4_COMPATIBLE_AUDIO_CODECS.has(probedSourceMeta.audioCodec?.toLowerCase());

    let renderResult;
    let deliveryResult;
    let audioForensics = null;
    let transcriptData = null;
    let styleData = null;
    const tRenderStart = Date.now();

    const releaseGpu = await scheduler.acquireGpuSlot(
      jobId,
      userId,
      (pos) => onProgress('QUEUED', `⏳ Queued for GPU processing (position #${pos})...`)
    );

    try {
      if (isAspectMatch && isCodecCompatible && probedSourceMeta.width <= masterWidth && probedSourceMeta.height <= masterHeight && !captions && presentation === 'standard') {
        // Fast Stream-Copy bypass (no aspect-ratio conversion or re-encoding needed)
        // Single FFmpeg remux process (-c copy) directly to masterVideoPath
        logger.info(
          `[${jobId}] Source matches target canvas (${probedSourceMeta.width}x${probedSourceMeta.height}, ${format.id}) and codec is compatible. Executing single-pass stream-copy master.`
        );
        await createExactClip({
          sourcePath: effectiveSourcePath,
          outputPath: masterVideoPath,
          startSeconds: 0,
          duration: clipDuration,
          jobId,
        });
        recordStage('VIDEO_RENDER', tRenderStart, Date.now());
        const metadata = await probeMedia(masterVideoPath, jobId);
        renderResult = {
          outputPath: masterVideoPath,
          duration: clipDuration,
          metadata,
          sourceMetadata: probedSourceMeta,
          sourceAware: {
            sourceWidth: probedSourceMeta.width,
            sourceHeight: probedSourceMeta.height,
            sourceFps: probedSourceMeta.fps,
            sourceCodec: probedSourceMeta.videoCodec,
            sourceClass: sourceClassification.sourceClass,
            masterWidth: metadata.width,
            masterHeight: metadata.height,
            masterFps: metadata.fps,
            masterRatio: format.id,
            masterClass: sourceClassification.masterClass,
            masterIsUpscaled: false,
          },
          encoder: 'stream_copy',
          isGpuUsed: false,
        };
      } else {
        let assSubtitlePath = null;
        if (captions) {
          await onProgress('TRANSCRIBING', '🎙️ Extracting audio and transcribing speech...');
          const tTranscribeStart = Date.now();
          const audioWavPath = path.join(jobDir, 'transcribe.wav');
          await extractAudioFromClip(effectiveSourcePath, audioWavPath, jobId, {
            startSeconds: 0,
            duration: clipDuration,
          });

          transcriptData = await transcribeAudio({
            audioPath: audioWavPath,
            jobDir,
            jobId,
          });

          let captionScaleOverride = null;
          if (presentation === 'square_focus') {
            // Foreground is a 1:1 square centered vertically.
            // On a 9:16 canvas, the square spans Y = [21.875%, 78.125%].
            // Positioning at normalizedY = 0.68 places captions cleanly in the
            // lower side of the center square clip (chest/torso region), well clear of the face.
            const resRatio = masterWidth / 2160; // Scales proportionally for 1080p (0.5), 1440p (0.667), 4K (1.0)
            const squareLowerY = 0.68;
            const computedMarginV = Math.round(masterHeight * (1 - squareLowerY));

            captionScaleOverride = {
              marginL: Math.round(120 * resRatio),
              marginR: Math.round(120 * resRatio),
              marginV: computedMarginV,
              normalizedY: squareLowerY,
              fontScale: 1.18 * resRatio,
            };
          }

          const captionRes = await generateCaptionAss({
            transcript: transcriptData,
            styleId: captionStyle || 'podcast-pro',
            captionConfig: captionConfig || null,
            ratio: format.id,
            canvasWidth: masterWidth,
            canvasHeight: masterHeight,
            captionScaleOverride,
            jobDir,
            jobId,
          });

          assSubtitlePath = captionRes.assPath;
          styleData = captionRes.style;
          recordStage('TRANSCRIPTION', tTranscribeStart, Date.now());
        }

        // Single-pass NVENC transform (NO intermediate exactClip trim)
        // FFmpeg performs seek (-ss), trim (-t), Lanczos scale/crop, and NVENC encode directly in ONE process
        await onProgress('PROCESSING', `🎬 Rendering ${format.label} master (${masterWidth}×${masterHeight}) [${presentation}]...`);
        logger.info(
          `[${jobId}] Executing single-pass ${format.label} master conversion directly on source ` +
          `(input: ${path.basename(effectiveSourcePath)}, presentation: ${presentation}, seek: 0s, duration: ${clipDuration}s, canvas: ${masterWidth}×${masterHeight}, captions: ${assSubtitlePath ? 'yes' : 'no'})...`
        );

        renderResult = await processVerticalClip({
          sourcePath: effectiveSourcePath,
          outputPath: masterVideoPath,
          startSeconds: 0,
          endSeconds: clipDuration,
          ratio: format.id,
          presentation,
          targetWidth:  masterWidth,
          targetHeight: masterHeight,
          sourceClass:  sourceClassification.sourceClass,
          masterClass:  sourceClassification.masterClass,
          jobId,
          isSourceTrimmed: true,
          assPath: assSubtitlePath,
          onEncodingProgress: (prog) => {
            if (prog.out_time && prog.speed) {
              const curTime = prog.out_time.slice(0, 8);
              logger.debug(`[${jobId}] Progress: ${curTime} (${prog.speed})`);
            }
          },
        });
        recordStage('VIDEO_RENDER', tRenderStart, Date.now());
      }

      // Verify strictly 1 audio stream and 1 video stream on master
      if (renderResult.metadata.audioStreamsCount > 1) {
        throw new Error(
          `Master render validation failed: strictly 1 audio stream required, found ${renderResult.metadata.audioStreamsCount}.`
        );
      }
      if (renderResult.metadata.videoStreamsCount !== 1) {
        throw new Error(
          `Master render validation failed: strictly 1 video stream required, found ${renderResult.metadata.videoStreamsCount}.`
        );
      }

      await traceAudioStage('MASTER', masterVideoPath, jobId);

      try {
        audioForensics = await printOriginalAudioForensics({
          url,
          originalLanguage: formatDecision?.originalLanguage,
          selectedVideo: formatDecision?.selectedVideo,
          selectedAudio: formatDecision?.selectedAudio,
          sourcePath: effectiveSourcePath,
          masterPath: masterVideoPath,
          clipStart: 0,
          clipDuration,
          jobId,
        });
      } catch (forensicsErr) {
        logger.warn(`[${jobId}] Audio forensics generation failed:`, forensicsErr.message);
      }

      // Stage 3: Adaptive Telegram Delivery Planning
      await onProgress('DELIVERY', '📦 Planning optimal Telegram delivery tier...');
      const tPlanStart = Date.now();
      deliveryResult = await planAndRenderDelivery({
        masterPath: masterVideoPath,
        masterMetadata: renderResult.metadata,
        jobDir,
        jobId,
        duration: renderResult.duration,
        ratio: format.id,
        masterWidth,
        masterHeight,
        onProgress,
      });
      recordStage('DELIVERY_PLAN', tPlanStart, Date.now());
      await traceAudioStage('DELIVERY', deliveryResult.deliveredPath, jobId);
    } finally {
      releaseGpu();
    }

    recordStage('TOTAL_PIPELINE', startTimeMs, Date.now());

    // Write deterministic metadata.json for job auditing
    try {
      const metadataJsonPath = path.join(jobDir, 'metadata.json');
      await fs.writeFile(
        metadataJsonPath,
        JSON.stringify(
          {
            jobId,
            url,
            startTime,
            endTime,
            duration: clipDuration,
            ratio: format.id,
            sourceWidth: probedSourceMeta.width,
            sourceHeight: probedSourceMeta.height,
            sourceFps: probedSourceMeta.fps,
            sourceCodec: probedSourceMeta.videoCodec,
            masterWidth,
            masterHeight,
            encoder: renderResult.encoder,
            stageTimings,
            audioForensics,
            delivery: {
              tierName: deliveryResult.tierName,
              tierId: deliveryResult.tierId,
              fileSizeMB: deliveryResult.fileSizeMB,
              width: deliveryResult.width,
              height: deliveryResult.height,
              fps: deliveryResult.fps,
            },
            createdAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (metaErr) {
      logger.warn(`[${jobId}] Failed to write metadata.json:`, metaErr.message);
    }

    const renderSec = Number(stageTimings.VIDEO_RENDER?.durationSec) || 0;
    const realtimeFactor = renderSec > 0 ? (clipDuration / renderSec).toFixed(2) : 'N/A';
    const elapsedTotal = ((Date.now() - startTimeMs) / 1000).toFixed(1);

    logger.info(
      `\n================================\n` +
      `[PERFORMANCE]\n` +
      `jobId=${jobId}\n` +
      `duration=${clipDuration}s\n` +
      `download_time=${stageTimings.DOWNLOAD?.durationSec || '0.0'}s\n` +
      `render_time=${stageTimings.VIDEO_RENDER?.durationSec || '0.0'}s\n` +
      `realtime=${realtimeFactor}x\n` +
      `encoder=${renderResult.encoder}\n` +
      `fps=${renderResult.metadata?.fps || 0}\n` +
      `canvas=${masterWidth}x${masterHeight}\n` +
      `================================`
    );

    logAudioPolicy();

    logger.info(
      `[${jobId}] [BENCHMARK_SUMMARY]\n` +
      `  DOWNLOAD:           ${stageTimings.DOWNLOAD?.durationSec || '0.0'}s (${stageTimings.DOWNLOAD?.durationMs || 0}ms)\n` +
      `  ALIGNMENT:          ${stageTimings.ALIGNMENT?.durationSec || '0.0'}s (${stageTimings.ALIGNMENT?.durationMs || 0}ms)\n` +
      `  VIDEO_RENDER:       ${stageTimings.VIDEO_RENDER?.durationSec || '0.0'}s (${renderResult.encoder})\n` +
      `  DELIVERY_PLAN:      ${stageTimings.DELIVERY_PLAN?.durationSec || '0.0'}s\n` +
      `  TOTAL PIPELINE:     ${elapsedTotal}s\n` +
      `  Format:             ${format.label} (${format.id})\n` +
      `  Source:             ${probedSourceMeta.width}×${probedSourceMeta.height} → class: ${sourceClassification.sourceClass} | mode: ${config.outputQualityMode}\n` +
      `  Master Canvas:      ${masterWidth}×${masterHeight} (${sourceClassification.masterClass})\n` +
      `  Master Asset:       ${masterVideoPath} (${renderResult.metadata.fileSizeMB} MB | ${renderResult.metadata.width}×${renderResult.metadata.height} @ ${renderResult.metadata.fps}fps)\n` +
      `  Delivered File:     ${deliveryResult.deliveredPath} (${deliveryResult.fileSizeMB} MB | ${deliveryResult.width}×${deliveryResult.height} @ ${deliveryResult.fps}fps)\n` +
      `  Delivery Tier:      ${deliveryResult.tierName} (${deliveryResult.tierId})`
    );

    return {
      jobId,
      ratio: format.id,
      format,
      sourceClassification,
      jobDir,
      sourcePath,
      masterPath: masterVideoPath,
      masterMetadata: renderResult.metadata,
      sourceMetadata: renderResult.sourceMetadata,
      sourceAware: renderResult.sourceAware,
      delivery: deliveryResult,
      deliveredPath: deliveryResult.deliveredPath,
      outputPath: deliveryResult.deliveredPath,
      duration: renderResult.duration,
      presentation,
      metadata: deliveryResult,
      transcript: transcriptData,
      style: styleData,
      encoder: renderResult.encoder,
      isGpuUsed: renderResult.isGpuUsed,
      stageTimings,
      audioForensics,
      cleanup,
    };

  } catch (error) {
    const elapsedFail = ((Date.now() - startTimeMs) / 1000).toFixed(1);
    const stage = error instanceof PipelineError ? error.stage : 'UNKNOWN';

    logger.error(
      `[${jobId}] [PIPELINE_ERROR] Job failed after ${elapsedFail}s at stage [${stage}]:\n` +
      `  Message:  ${error.message}\n` +
      `  ExitCode: ${error.exitCode ?? 'N/A'}\n` +
      `  Signal:   ${error.signal ?? 'N/A'}\n` +
      `  Stderr:   ${error.stderr || '(none)'}`
    );

    // Attempt automatic cleanup on failure
    await cleanup();
    throw error;
  }
}
