/**
 * Media Aligner
 *
 * Measures section download pre-roll (keyframe offset) and aligns downloaded
 * media so that requestedStart corresponds to output time 0 for both video
 * and audio. Preserves audio using -c:a copy with zero audio re-encoding.
 */

import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { probeAudio, resolveAudioPlan, logAudioSource, logAudioOutput } from './audioPreservation.js';
import { parseTimestampToSeconds } from '../../utils/validator.js';

/**
 * Probes the exact packet timestamps and stream timing of a media file.
 *
 * @param {string} sourcePath - Absolute path to media file
 * @param {string} [jobId='align'] - Job identifier for logging
 * @returns {Promise<object>} Timing metrics
 */
export async function probeSectionTiming(sourcePath, jobId = 'align') {
  const runFfprobe = (args) =>
    new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn('ffprobe', args, { windowsHide: true });
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error(`Failed to parse ffprobe JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`ffprobe failed (code ${code}): ${stderr.slice(-300)}`));
        }
      });
      proc.on('error', reject);
    });

  // 1. Probe stream general info
  const streamInfo = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,start_time,duration:format=duration,start_time',
    '-of', 'json',
    sourcePath,
  ]);

  const streams = streamInfo.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const hasAudio = !!audioStream;

  // 2. Probe video packets (first 10 packets are sufficient to inspect pre-roll)
  let videoFirstPts = 0.0;
  let videoFirstDts = 0.0;
  try {
    const vPackets = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-of', 'json',
      sourcePath,
    ]);
    const pkts = vPackets.packets || [];
    if (pkts.length > 0 && pkts[0].pts_time !== undefined) {
      videoFirstPts = parseFloat(pkts[0].pts_time) || 0.0;
      videoFirstDts = parseFloat(pkts[0].dts_time) || 0.0;
    }
  } catch (err) {
    logger.warn(`[${jobId}] Could not probe video packets: ${err.message}`);
  }

  // 3. Probe audio packets if audio stream exists
  let audioFirstPts = 0.0;
  let audioFirstDts = 0.0;
  if (hasAudio) {
    try {
      const aPackets = await runFfprobe([
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_packets',
        '-of', 'json',
        sourcePath,
      ]);
      const pkts = aPackets.packets || [];
      if (pkts.length > 0 && pkts[0].pts_time !== undefined) {
        audioFirstPts = parseFloat(pkts[0].pts_time) || 0.0;
        audioFirstDts = parseFloat(pkts[0].dts_time) || 0.0;
      }
    } catch (err) {
      logger.warn(`[${jobId}] Could not probe audio packets: ${err.message}`);
    }
  }

  const detectedVideoPreroll = Math.max(0.0, -videoFirstPts);
  const detectedAudioPreroll = Math.max(0.0, -audioFirstPts);
  const contentAlignmentOffset = Math.abs(detectedVideoPreroll - detectedAudioPreroll);
  const hasPreRoll = detectedVideoPreroll > 0.005 || detectedAudioPreroll > 0.005;

  return {
    videoFirstPts,
    videoFirstDts,
    audioFirstPts,
    audioFirstDts,
    videoStartTime: parseFloat(videoStream?.start_time || '0') || 0.0,
    audioStartTime: parseFloat(audioStream?.start_time || '0') || 0.0,
    videoDuration: parseFloat(videoStream?.duration || '0') || 0.0,
    audioDuration: parseFloat(audioStream?.duration || '0') || 0.0,
    formatDuration: parseFloat(streamInfo.format?.duration || '0') || 0.0,
    hasAudio,
    detectedVideoPreroll,
    detectedAudioPreroll,
    contentAlignmentOffset,
    hasPreRoll,
  };
}

/**
 * Aligns source media by trimming pre-roll so requestedStart corresponds to
 * output time 0 for BOTH video and audio.
 *
 * @param {object} params
 * @param {string} params.sourcePath - Downloaded source file
 * @param {string} params.jobDir - Directory for temporary aligned file
 * @param {string} [params.jobId='align'] - Job identifier
 * @param {string|number} params.startTime - Requested start timestamp (e.g. '00:10' or 10)
 * @param {string|number} params.endTime - Requested end timestamp (e.g. '00:30' or 30)
 * @param {number} params.clipDuration - Requested clip duration in seconds
 * @param {boolean} params.isSourceTrimmed - True if downloaded with --download-sections
 * @returns {Promise<object>} Aligned source metadata and path
 */
export async function alignSourceMedia({
  sourcePath,
  jobDir,
  jobId = 'align',
  startTime,
  endTime,
  clipDuration,
  isSourceTrimmed,
}) {
  const tStart = Date.now();
  const timing = await probeSectionTiming(sourcePath, jobId);

  const startSec = typeof startTime === 'number' ? startTime : parseTimestampToSeconds(startTime);
  const endSec = typeof endTime === 'number' ? endTime : parseTimestampToSeconds(endTime);

  const videoFirstContentTime = isSourceTrimmed
    ? startSec + timing.videoFirstPts
    : timing.videoFirstPts;
  const audioFirstContentTime = isSourceTrimmed
    ? startSec + timing.audioFirstPts
    : timing.audioFirstPts;

  logger.info(
    `\n[SECTION ALIGNMENT PROBE]\n` +
    `job_id=${jobId}\n` +
    `requested_start=${startTime} (${startSec}s)\n` +
    `requested_end=${endTime} (${endSec}s)\n` +
    `requested_duration=${clipDuration}s\n` +
    `is_source_trimmed=${isSourceTrimmed}\n` +
    `video_first_pts=${timing.videoFirstPts.toFixed(6)}\n` +
    `audio_first_pts=${timing.audioFirstPts.toFixed(6)}\n` +
    `detected_video_preroll=${timing.detectedVideoPreroll.toFixed(6)}s\n` +
    `detected_audio_preroll=${timing.detectedAudioPreroll.toFixed(6)}s\n` +
    `alignment_offset=${timing.contentAlignmentOffset.toFixed(6)}s\n` +
    `video_first_content_time=${videoFirstContentTime.toFixed(6)}s\n` +
    `audio_first_content_time=${audioFirstContentTime.toFixed(6)}s`
  );

  // If no alignment is needed (e.g. clean cut with 0 pre-roll and exact duration)
  if (isSourceTrimmed && !timing.hasPreRoll && Math.abs(timing.formatDuration - clipDuration) <= 0.2) {
    logger.info(`[${jobId}] Source is already cleanly aligned. No alignment remux needed.`);
    return {
      alignedSourcePath: sourcePath,
      timing,
      isAligned: false,
      alignmentDurationMs: Date.now() - tStart,
    };
  }

  const alignedSourcePath = path.join(jobDir, 'source_aligned.mp4');

  // Audio plan check: verify audio is strictly stream-copied
  let audioArgs = ['-c:a', 'copy'];
  if (timing.hasAudio) {
    const sourceAudio = await probeAudio(sourcePath, jobId);
    logAudioSource(sourceAudio);
    const audioPlan = resolveAudioPlan(sourceAudio, jobId);
    logAudioOutput(audioPlan);
    audioArgs = audioPlan.args;
  }

  // Build lightweight alignment stream-copy command
  // If isSourceTrimmed, cut point is at 0 in source.mp4; seek -ss 0 trims pre-roll.
  // If not isSourceTrimmed, seek to startSec.
  const seekArg = isSourceTrimmed ? '0' : String(startSec);

  const args = [
    '-y',
    '-ss', seekArg,
    '-i', sourcePath,
    '-t', String(clipDuration),
    '-map', '0:v:0',
  ];

  if (timing.hasAudio) {
    args.push('-map', '0:a:0', ...audioArgs);
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'copy',
    '-movflags', '+faststart',
    alignedSourcePath
  );

  logger.info(`[${jobId}] Executing lightweight source alignment:\nffmpeg ${args.join(' ')}`);

  await new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(alignedSourcePath);
      } else {
        logger.error(`[${jobId}] alignSourceMedia failed with code ${code}: ${stderr.slice(-400)}`);
        reject(new Error(`Failed to align source media: exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });

  const alignmentDurationMs = Date.now() - tStart;

  // Verify alignment on output
  const finalTiming = await probeSectionTiming(alignedSourcePath, jobId);
  const finalAvContentOffset = Math.abs(finalTiming.videoFirstPts - finalTiming.audioFirstPts);

  logger.info(
    `\n[SECTION ALIGNMENT COMPLETE]\n` +
    `job_id=${jobId}\n` +
    `aligned_source=${path.basename(alignedSourcePath)}\n` +
    `final_video_first_pts=${finalTiming.videoFirstPts.toFixed(6)}\n` +
    `final_audio_first_pts=${finalTiming.audioFirstPts.toFixed(6)}\n` +
    `final_av_content_offset=${finalAvContentOffset.toFixed(6)}s\n` +
    `output_duration=${finalTiming.formatDuration.toFixed(3)}s\n` +
    `alignment_time=${(alignmentDurationMs / 1000).toFixed(2)}s`
  );

  return {
    alignedSourcePath,
    timing,
    finalTiming,
    isAligned: true,
    alignmentOffset: timing.contentAlignmentOffset,
    alignmentDurationMs,
  };
}
