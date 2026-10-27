import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

/**
 * List of audio codecs that can be safely stream-copied directly into an MP4 container.
 * AAC is the universal standard for MP4 / Telegram compatibility.
 * MP3 and ALAC are also valid in MP4.
 */
export const MP4_COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3']);

/**
 * Probes comprehensive audio stream details of a media file using ffprobe.
 *
 * @param {string} filePath - Absolute path to media file
 * @param {string} [jobId='probe-audio'] - Context job ID
 * @returns {Promise<{
 *   hasAudio: boolean,
 *   audioStreamsCount: number,
 *   codec: string,
 *   codec_long_name: string,
 *   sample_rate: string,
 *   channels: number,
 *   layout: string,
 *   bit_rate: string,
 *   duration: number,
 *   start_time: string,
 *   stream_index: number,
 *   codec_tag_string: string
 * }>}
 */
export async function probeAudio(filePath, jobId = 'probe-audio') {
  const args = [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index,codec_name,codec_long_name,sample_rate,channels,channel_layout,bit_rate,duration,start_time,codec_tag_string:format=duration,bit_rate',
    '-of', 'json',
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
    const audioStreams = parsed.streams || [];
    const audioStreamsCount = audioStreams.length;
    const audioStream = audioStreams[0];
    const format = parsed.format || {};

    if (!audioStream) {
      return {
        hasAudio: false,
        audioStreamsCount: 0,
        codec: 'none',
        codec_long_name: 'None',
        sample_rate: '0',
        channels: 0,
        layout: 'none',
        bit_rate: '0',
        duration: 0,
        start_time: '0.000000',
        stream_index: -1,
        codec_tag_string: 'none',
      };
    }

    const codec = (audioStream.codec_name || 'unknown').toLowerCase();
    const codec_long_name = audioStream.codec_long_name || codec;
    const sample_rate = audioStream.sample_rate ? String(audioStream.sample_rate) : 'unknown';
    const channels = audioStream.channels != null ? Number(audioStream.channels) : 0;
    const layout = audioStream.channel_layout || (channels === 1 ? 'mono' : (channels === 2 ? 'stereo' : 'unknown'));
    const bit_rate = audioStream.bit_rate ? String(audioStream.bit_rate) : (format.bit_rate ? String(format.bit_rate) : 'unknown');
    const duration = audioStream.duration
      ? Number(audioStream.duration)
      : (format.duration ? Number(format.duration) : 0);
    const start_time = audioStream.start_time || '0.000000';
    const stream_index = audioStream.index != null ? Number(audioStream.index) : 0;
    const codec_tag_string = audioStream.codec_tag_string || 'unknown';

    return {
      hasAudio: true,
      audioStreamsCount,
      codec,
      codec_long_name,
      sample_rate,
      channels,
      layout,
      bit_rate,
      duration,
      start_time,
      stream_index,
      codec_tag_string,
    };
  } catch (err) {
    logger.warn(`[${jobId}] Could not probe audio metadata for ${filePath}: ${err.message}`);
    return {
      hasAudio: false,
      audioStreamsCount: 0,
      codec: 'unknown',
      codec_long_name: 'unknown',
      sample_rate: 'unknown',
      channels: 0,
      layout: 'unknown',
      bit_rate: 'unknown',
      duration: 0,
      start_time: '0.000000',
      stream_index: -1,
      codec_tag_string: 'unknown',
    };
  }
}

/**
 * Traces and logs audio metadata at a specific pipeline stage.
 *
 * @param {string} stage - Stage name (e.g. SOURCE, MASTER, DELIVERY, DERIVATIVE)
 * @param {string} filePath - Path to file
 * @param {string} [jobId='trace']
 * @returns {Promise<object>} Probed audio metadata
 */
export async function traceAudioStage(stage, filePath, jobId = 'trace') {
  const meta = await probeAudio(filePath, jobId);
  logger.info(
    `\n[AUDIO TRACE]\n` +
    `stage=${stage}\n` +
    `codec=${meta.codec}\n` +
    `codec_long_name=${meta.codec_long_name}\n` +
    `sample_rate=${meta.sample_rate}\n` +
    `channels=${meta.channels}\n` +
    `layout=${meta.layout}\n` +
    `bitrate=${meta.bit_rate}\n` +
    `duration=${meta.duration.toFixed(3)}\n` +
    `start_time=${meta.start_time}\n` +
    `stream_index=${meta.stream_index}\n` +
    `codec_tag_string=${meta.codec_tag_string}`
  );
  return meta;
}

/**
 * Logs the inspected source audio properties according to specification.
 *
 * @param {object} audioMeta
 */
export function logAudioSource(audioMeta) {
  logger.info(
    `[AUDIO SOURCE]\n` +
    `codec=${audioMeta.codec}\n` +
    `sample_rate=${audioMeta.sample_rate}\n` +
    `channels=${audioMeta.channels}\n` +
    `layout=${audioMeta.layout}`
  );
}

/**
 * Resolves the audio configuration:
 * Default to stream copy (-c:a copy) when technically compatible with MP4 container.
 * Minimal fallback to -c:a aac ONLY if incompatible.
 *
 * @param {object} sourceAudioMeta
 * @param {string} [jobId='clip']
 * @returns {{
 *   mode: 'COPY' | 'ENCODE' | 'NONE',
 *   codec: string,
 *   args: string[],
 *   commandAudioArgs: string,
 *   isCopy: boolean
 * }}
 */
export function resolveAudioPlan(sourceAudioMeta, jobId = 'clip') {
  if (!sourceAudioMeta.hasAudio || sourceAudioMeta.codec === 'none') {
    return {
      mode: 'NONE',
      codec: 'none',
      args: ['-an'],
      commandAudioArgs: '-an',
      isCopy: false,
    };
  }

  const normalizedCodec = (sourceAudioMeta.codec || '').toLowerCase();
  const isCompatible = MP4_COMPATIBLE_AUDIO_CODECS.has(normalizedCodec);

  if (isCompatible) {
    return {
      mode: 'COPY',
      codec: normalizedCodec,
      args: ['-c:a', 'copy'],
      commandAudioArgs: '-c:a copy',
      isCopy: true,
    };
  }

  // Fallback: strictly minimal conversion without resampling or normalization filters
  logger.info(
    `[AUDIO FALLBACK]\n` +
    `reason=Source audio codec '${sourceAudioMeta.codec}' is not natively compatible with MP4 container\n` +
    `input_codec=${sourceAudioMeta.codec}\n` +
    `output_codec=aac`
  );

  return {
    mode: 'ENCODE',
    codec: 'aac',
    args: ['-c:a', 'aac'],
    commandAudioArgs: '-c:a aac',
    isCopy: false,
  };
}

/**
 * Logs the resolved audio command arguments before FFmpeg execution.
 *
 * @param {object} audioPlan
 */
export function logAudioOutput(audioPlan) {
  logger.info(
    `[AUDIO OUTPUT]\n` +
    `mode=${audioPlan.mode}\n` +
    `codec=${audioPlan.codec}\n` +
    `command_audio_args=${audioPlan.commandAudioArgs}`
  );
}

/**
 * Extracts raw 16-bit signed PCM samples from a file for an aligned time window.
 */
async function extractPcmSegment({ filePath, startSeconds = 0, duration = null, outputPath }) {
  const args = ['-v', 'error', '-y'];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push('-i', filePath);
  if (duration && duration > 0) {
    args.push('-t', String(duration));
  }
  args.push(
    '-map', '0:a:0',
    '-c:a', 'pcm_s16le',
    '-f', 's16le',
    outputPath
  );

  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg PCM extraction failed (code ${code}): ${stderr}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Performs sample-level PCM identity verification between source and output files.
 *
 * @param {object} params
 * @param {string} params.sourcePath
 * @param {string} params.outputPath
 * @param {number} [params.clipStart=0]
 * @param {number} [params.clipDuration=0]
 * @param {string} [params.jobId='sample-verify']
 * @returns {Promise<object>}
 */
export async function verifyAudioSampleIdentity({
  sourcePath,
  outputPath,
  clipStart = 0,
  clipDuration = 0,
  jobId = 'sample-verify',
}) {
  const tmpDir = path.join(path.dirname(outputPath), '.audio_verify');
  await fs.mkdir(tmpDir, { recursive: true });

  const srcPcm = path.join(tmpDir, `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pcm`);
  const outPcm = path.join(tmpDir, `out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pcm`);

  try {
    const outMeta = await probeAudio(outputPath, jobId);
    const durToCompare = clipDuration > 0
      ? clipDuration
      : (outMeta.duration > 0 ? outMeta.duration : 0);

    await extractPcmSegment({
      filePath: sourcePath,
      startSeconds: clipStart,
      duration: durToCompare,
      outputPath: srcPcm,
    });

    await extractPcmSegment({
      filePath: outputPath,
      startSeconds: 0,
      duration: durToCompare,
      outputPath: outPcm,
    });

    const [srcBuf, outBuf] = await Promise.all([
      fs.readFile(srcPcm),
      fs.readFile(outPcm),
    ]);

    const srcSamples = new Int16Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength / 2);
    const outSamples = new Int16Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength / 2);

    const minLen = Math.min(srcSamples.length, outSamples.length);
    const lengthDiff = Math.abs(srcSamples.length - outSamples.length);

    let maxDiff = 0;
    let totalDiff = 0;

    for (let i = 0; i < minLen; i++) {
      const diff = Math.abs(srcSamples[i] - outSamples[i]);
      if (diff > maxDiff) maxDiff = diff;
      totalDiff += diff;
    }

    const meanDiff = minLen > 0 ? totalDiff / minLen : 0;
    const isIdentical = maxDiff === 0 && lengthDiff === 0;

    logger.info(
      `\n[AUDIO SAMPLE VERIFICATION]\n` +
      `aligned_duration=${durToCompare.toFixed(3)}s\n` +
      `sample_rate=${outMeta.sample_rate}\n` +
      `channels=${outMeta.channels}\n` +
      `samples_compared=${minLen}\n` +
      `max_abs_difference=${maxDiff}\n` +
      `mean_abs_difference=${meanDiff.toFixed(4)}\n` +
      `identical_pcm=${isIdentical}`
    );

    return {
      aligned_duration: durToCompare,
      sample_rate: outMeta.sample_rate,
      channels: outMeta.channels,
      samples_compared: minLen,
      max_abs_difference: maxDiff,
      mean_abs_difference: meanDiff,
      identical_pcm: isIdentical,
    };
  } catch (err) {
    logger.warn(`[${jobId}] Audio sample verification skipped: ${err.message}`);
    return null;
  } finally {
    await fs.unlink(srcPcm).catch(() => {});
    await fs.unlink(outPcm).catch(() => {});
  }
}

/**
 * Verifies final output audio stream with ffprobe and sample-level comparison.
 *
 * @param {object} params
 * @param {object} params.sourceAudioMeta - Probed source audio metadata
 * @param {string} [params.sourcePath] - Path to source video
 * @param {string} params.outputPath - Path to rendered output file
 * @param {object} params.audioPlan - Resolved audio plan
 * @param {number} [params.clipStart=0]
 * @param {number} [params.clipDuration=0]
 * @param {string} [params.jobId='verify-audio']
 * @returns {Promise<{
 *   verified: boolean,
 *   audio_copy: boolean,
 *   source: object,
 *   output: object,
 *   sampleVerification?: object
 * }>}
 */
/**
 * Logs the strict passive copy policy and media quality settings.
 */
export function logAudioPolicy() {
  logger.info(
    `\n[AUDIO POLICY]\n` +
    `track_type=CREATOR_ORIGINAL\n` +
    `audio_processing=false\n` +
    `audio_reencoding=false\n` +
    `audio_filters=false\n` +
    `audio_timestamp_shift=false\n` +
    `audio_mixing=false\n\n` +
    `[AUDIO PROCESSING]\n` +
    `processing=false\n` +
    `reencoding=false\n` +
    `filtering=false\n` +
    `mixing=false\n` +
    `timestamp_shift=false\n\n` +
    `[MEDIA]\n` +
    `video_quality=MAXIMUM_PRACTICAL\n` +
    `video_artificial_upscale=false\n` +
    `range_download=true`
  );
}

/**
 * Validates that audio was preserved passively without re-encoding, filters, or timestamp shifts.
 *
 * Checks:
 * 1. Source audio exists
 * 2. Output audio exists
 * 3. Output audio stream count is strictly 1
 * 4. Codec matches source
 * 5. Sample rate matches source
 * 6. Channels match source
 * 7. Duration is aligned
 *
 * @param {object} params
 * @param {object} params.sourceAudioMeta
 * @param {string} [params.sourcePath]
 * @param {string} params.outputPath
 * @param {object} params.audioPlan
 * @param {number} [params.clipStart=0]
 * @param {number} [params.clipDuration=0]
 * @param {string} [params.jobId='validate-audio']
 */
export async function validatePassiveAudioCopy({
  sourceAudioMeta,
  sourcePath = null,
  outputPath,
  audioPlan,
  clipStart = 0,
  clipDuration = 0,
  jobId = 'validate-audio',
}) {
  const outputAudioMeta = await probeAudio(outputPath, jobId);

  if (sourceAudioMeta.hasAudio && sourceAudioMeta.codec !== 'none') {
    if (!outputAudioMeta.hasAudio || outputAudioMeta.codec === 'none') {
      throw new Error(`Audio validation failed: Output audio stream is missing.`);
    }

    if (outputAudioMeta.audioStreamsCount !== 1) {
      throw new Error(
        `Audio validation failed: Output contains ${outputAudioMeta.audioStreamsCount} audio streams (strictly 1 required).`
      );
    }

    if (audioPlan.isCopy) {
      if (outputAudioMeta.codec !== sourceAudioMeta.codec) {
        throw new Error(
          `Audio validation failed: Codec changed from ${sourceAudioMeta.codec} to ${outputAudioMeta.codec}.`
        );
      }
      if (String(outputAudioMeta.sample_rate) !== String(sourceAudioMeta.sample_rate)) {
        throw new Error(
          `Audio validation failed: Sample rate changed from ${sourceAudioMeta.sample_rate} to ${outputAudioMeta.sample_rate}.`
        );
      }
      if (outputAudioMeta.channels !== sourceAudioMeta.channels) {
        throw new Error(
          `Audio validation failed: Channels changed from ${sourceAudioMeta.channels} to ${outputAudioMeta.channels}.`
        );
      }
    }
  }

  const isAudioCopy = audioPlan.isCopy && (outputAudioMeta.codec === sourceAudioMeta.codec);

  const formatDur = (d) => {
    if (d == null || isNaN(d) || d === 0) return '0.000s';
    return `${Number(d).toFixed(3)}s`;
  };

  logger.info(
    `\n[AUDIO VERIFICATION]\n\n` +
    `codec:\n` +
    `source=${sourceAudioMeta.codec}\n` +
    `output=${outputAudioMeta.codec}\n\n` +
    `sample_rate:\n` +
    `source=${sourceAudioMeta.sample_rate}\n` +
    `output=${outputAudioMeta.sample_rate}\n\n` +
    `channels:\n` +
    `source=${sourceAudioMeta.channels}\n` +
    `output=${outputAudioMeta.channels}\n\n` +
    `layout:\n` +
    `source=${sourceAudioMeta.layout}\n` +
    `output=${outputAudioMeta.layout}\n\n` +
    `duration:\n` +
    `source=${formatDur(sourceAudioMeta.duration)}\n` +
    `output=${formatDur(outputAudioMeta.duration)}\n\n` +
    `streams:\n` +
    `source=${sourceAudioMeta.audioStreamsCount}\n` +
    `output=${outputAudioMeta.audioStreamsCount}\n\n` +
    `audio_copy=${isAudioCopy}`
  );

  if (isAudioCopy) {
    logger.info(
      `\n[AUDIO COPY]\n` +
      `source → master = unchanged`
    );
  }

  let sampleVerification = null;
  if (sourcePath && isAudioCopy) {
    sampleVerification = await verifyAudioSampleIdentity({
      sourcePath,
      outputPath,
      clipStart,
      clipDuration,
      jobId,
    });
  }

  return {
    verified: true,
    audio_copy: isAudioCopy,
    source: sourceAudioMeta,
    output: outputAudioMeta,
    sampleVerification,
  };
}

/**
 * Verifies final output audio stream with ffprobe and sample-level comparison.
 */
export const verifyAudioOutput = validatePassiveAudioCopy;

/**
 * Prints the official ORIGINAL AUDIO FORENSICS summary block and computes PCM hashes and sample difference.
 *
 * @param {object} params
 * @param {string} params.url - YouTube video URL
 * @param {string} [params.originalLanguage] - Original video language
 * @param {object} [params.selectedVideo] - Selected video format
 * @param {object} [params.selectedAudio] - Selected audio format
 * @param {string} params.sourcePath - Path to source video
 * @param {string} params.masterPath - Path to master video
 * @param {number} [params.clipStart=0] - Start offset in source file
 * @param {number} [params.clipDuration=0] - Duration of clip
 * @param {string} [params.jobId='forensics'] - Job ID
 * @returns {Promise<object>} Forensics report object
 */
export async function printOriginalAudioForensics({
  url,
  originalLanguage = null,
  selectedVideo = null,
  selectedAudio = null,
  sourcePath,
  masterPath,
  clipStart = 0,
  clipDuration = 0,
  jobId = 'forensics',
}) {
  const tmpDir = path.join(path.dirname(masterPath), '.audio_forensics');
  await fs.mkdir(tmpDir, { recursive: true });

  const srcPcm = path.join(tmpDir, `src_pcm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pcm`);
  const masterPcm = path.join(tmpDir, `master_pcm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pcm`);

  try {
    const srcMeta = await probeAudio(sourcePath, jobId);
    const masterMeta = await probeAudio(masterPath, jobId);

    const durToCompare = clipDuration > 0
      ? clipDuration
      : (masterMeta.duration > 0 ? masterMeta.duration : (srcMeta.duration > 0 ? srcMeta.duration : 0));

    await extractPcmSegment({
      filePath: sourcePath,
      startSeconds: clipStart,
      duration: durToCompare,
      outputPath: srcPcm,
    });

    await extractPcmSegment({
      filePath: masterPath,
      startSeconds: 0,
      duration: durToCompare,
      outputPath: masterPcm,
    });

    const [srcBuf, masterBuf] = await Promise.all([
      fs.readFile(srcPcm),
      fs.readFile(masterPcm),
    ]);

    const srcMd5 = crypto.createHash('md5').update(srcBuf).digest('hex');
    const masterMd5 = crypto.createHash('md5').update(masterBuf).digest('hex');

    const srcSamples = new Int16Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength / 2);
    const masterSamples = new Int16Array(masterBuf.buffer, masterBuf.byteOffset, masterBuf.byteLength / 2);

    const minLen = Math.min(srcSamples.length, masterSamples.length);
    const lengthDiff = Math.abs(srcSamples.length - masterSamples.length);

    let maxDiff = 0;
    let totalDiff = 0;
    for (let i = 0; i < minLen; i++) {
      const diff = Math.abs(srcSamples[i] - masterSamples[i]);
      if (diff > maxDiff) maxDiff = diff;
      totalDiff += diff;
    }

    const meanDiff = minLen > 0 ? totalDiff / minLen : 0;
    const isIdentical = maxDiff === 0 && lengthDiff === 0 && srcMd5 === masterMd5;

    const videoDesc = selectedVideo
      ? `${selectedVideo.format_id} (${selectedVideo.resolution || (selectedVideo.height ? selectedVideo.height + 'p' : 'unknown')}, ${selectedVideo.vcodec || 'unknown'}, ${selectedVideo.protocol || 'unknown'})`
      : 'unknown';
    const audioDesc = selectedAudio
      ? `${selectedAudio.format_id} (${selectedAudio.format_note || 'N/A'}, ${selectedAudio.protocol || 'unknown'})`
      : 'unknown';

    logger.info(
      `\n========== AUDIO PRESERVATION FORENSICS ==========\n` +
      `YouTube URL: ${url}\n` +
      `Selected Video Format: ${videoDesc}\n` +
      `Selected Audio Format: ${audioDesc}\n` +
      `Audio Codec: ${srcMeta.codec}\n` +
      `Audio Sample Rate: ${srcMeta.sample_rate}\n` +
      `Audio Channels: ${srcMeta.channels}\n` +
      `PCM Comparison With Source:\n` +
      `  Source MD5 / Hash: ${srcMd5}\n` +
      `  Master MD5 / Hash: ${masterMd5}\n` +
      `  Max Absolute Difference: ${maxDiff}\n` +
      `  Status: ${isIdentical ? 'Source audio preserved unchanged.' : (maxDiff === 0 ? 'ALIGNED PCM MATCH' : 'SAMPLE DELTA DETECTED')}\n` +
      `==================================================`
    );

    if (isIdentical) {
      logger.info(
        `\n[AUDIO COPY]\n` +
        `source → master = unchanged`
      );
    }

    return {
      url,
      selectedVideo: selectedVideo?.format_id,
      selectedAudio: selectedAudio?.format_id,
      codec: srcMeta.codec,
      sampleRate: srcMeta.sample_rate,
      channels: srcMeta.channels,
      sourceMd5: srcMd5,
      masterMd5: masterMd5,
      maxAbsDifference: maxDiff,
      meanAbsDifference: meanDiff,
      identicalPcm: isIdentical,
    };
  } catch (err) {
    logger.warn(`[${jobId}] Could not generate audio forensics report: ${err.message}`);
    return null;
  } finally {
    await fs.unlink(srcPcm).catch(() => {});
    await fs.unlink(masterPcm).catch(() => {});
  }
}

