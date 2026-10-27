import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Extracts raw 16-bit signed little-endian PCM samples using FFmpeg.
 *
 * @param {object} params
 * @param {string} params.filePath - Input media file
 * @param {number} [params.startSeconds=0] - Seek start in seconds
 * @param {number} [params.duration] - Optional duration to extract
 * @param {string} params.outputPath - Output .pcm file path
 * @returns {Promise<Buffer>}
 */
export async function extractPcm({ filePath, startSeconds = 0, duration = null, outputPath }) {
  const args = ['-v', 'error', '-y'];

  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push('-i', filePath);
  if (duration && duration > 0) {
    args.push('-t', String(duration));
  }

  // Force explicit mapping of first audio stream, 16-bit PCM, no filters, keep native sample rate and channels
  args.push(
    '-map', '0:a:0',
    '-c:a', 'pcm_s16le',
    '-f', 's16le',
    outputPath
  );

  await new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg PCM extraction failed (code ${code}): ${stderr}`));
    });
    proc.on('error', reject);
  });

  return await fs.readFile(outputPath);
}

/**
 * Computes audio statistics (Peak, RMS) for a buffer of int16 PCM samples.
 *
 * @param {Int16Array} samples
 * @returns {{ peak: number, rms: number, peakDb: number, rmsDb: number }}
 */
export function computePcmStats(samples) {
  if (!samples || samples.length === 0) {
    return { peak: 0, rms: 0, peakDb: -Infinity, rmsDb: -Infinity };
  }

  let peak = 0;
  let sumSquares = 0;

  for (let i = 0; i < samples.length; i++) {
    const val = Math.abs(samples[i]);
    if (val > peak) peak = val;
    sumSquares += val * val;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const maxInt16 = 32767;
  const peakDb = peak > 0 ? 20 * Math.log10(peak / maxInt16) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms / maxInt16) : -Infinity;

  return { peak, rms, peakDb, rmsDb };
}

/**
 * Performs sample-level comparison between two PCM sample arrays.
 *
 * @param {Int16Array} sourceSamples
 * @param {Int16Array} outputSamples
 * @returns {{
 *   samplesCompared: number,
 *   maxAbsDifference: number,
 *   meanAbsDifference: number,
 *   identicalPcm: boolean,
 *   lengthDiff: number
 * }}
 */
export function comparePcmSamples(sourceSamples, outputSamples) {
  const minLen = Math.min(sourceSamples.length, outputSamples.length);
  const lengthDiff = Math.abs(sourceSamples.length - outputSamples.length);

  let maxDiff = 0;
  let totalDiff = 0;

  for (let i = 0; i < minLen; i++) {
    const diff = Math.abs(sourceSamples[i] - outputSamples[i]);
    if (diff > maxDiff) maxDiff = diff;
    totalDiff += diff;
  }

  const meanDiff = minLen > 0 ? totalDiff / minLen : 0;
  const isIdentical = maxDiff === 0 && lengthDiff === 0;

  return {
    samplesCompared: minLen,
    maxAbsDifference: maxDiff,
    meanAbsDifference: meanDiff,
    identicalPcm: isIdentical,
    lengthDiff,
  };
}

/**
 * Probes audio stream details using ffprobe.
 */
export async function probeAudioStream(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,channel_layout,bit_rate,duration,start_time,codec_tag_string:format=duration,bit_rate',
    '-of', 'json',
    filePath,
  ];

  const stdout = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const proc = spawn('ffprobe', args, { windowsHide: true });
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `ffprobe exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  const format = parsed.format || {};

  return {
    codec: stream.codec_name || 'unknown',
    sample_rate: stream.sample_rate || 'unknown',
    channels: stream.channels || 0,
    channel_layout: stream.channel_layout || 'unknown',
    bit_rate: stream.bit_rate || format.bit_rate || 'unknown',
    duration: stream.duration ? Number(stream.duration) : (format.duration ? Number(format.duration) : 0),
    start_time: stream.start_time || '0.000000',
    codec_tag_string: stream.codec_tag_string || 'unknown',
  };
}

/**
 * Runs full audio identity test comparing source and output files for a specified time window.
 */
export async function runAudioIdentityTest({
  sourcePath,
  outputPath,
  clipStart = 0,
  clipDuration = 0,
  workDir = 'temp/audio_identity_work',
}) {
  await fs.mkdir(workDir, { recursive: true });

  const sourceAudioMeta = await probeAudioStream(sourcePath);
  const outputAudioMeta = await probeAudioStream(outputPath);

  const durationToCompare = clipDuration > 0
    ? clipDuration
    : (outputAudioMeta.duration > 0 ? outputAudioMeta.duration : sourceAudioMeta.duration);

  const sourcePcmPath = path.join(workDir, `src_${Date.now()}.pcm`);
  const outputPcmPath = path.join(workDir, `out_${Date.now()}.pcm`);

  // Extract aligned PCM
  const sourcePcmBuf = await extractPcm({
    filePath: sourcePath,
    startSeconds: clipStart,
    duration: durationToCompare,
    outputPath: sourcePcmPath,
  });

  const outputPcmBuf = await extractPcm({
    filePath: outputPath,
    startSeconds: 0, // output is already the clip, so start at 0
    duration: durationToCompare,
    outputPath: outputPcmPath,
  });

  const sourceSamples = new Int16Array(
    sourcePcmBuf.buffer,
    sourcePcmBuf.byteOffset,
    sourcePcmBuf.byteLength / 2
  );
  const outputSamples = new Int16Array(
    outputPcmBuf.buffer,
    outputPcmBuf.byteOffset,
    outputPcmBuf.byteLength / 2
  );

  const comparison = comparePcmSamples(sourceSamples, outputSamples);
  const sourceStats = computePcmStats(sourceSamples);
  const outputStats = computePcmStats(outputSamples);

  console.log(`\n========== AUDIO IDENTITY TEST ==========`);
  console.log(``);
  console.log(`Source:`);
  console.log(`codec=${sourceAudioMeta.codec}`);
  console.log(`sample_rate=${sourceAudioMeta.sample_rate}`);
  console.log(`channels=${sourceAudioMeta.channels}`);
  console.log(`duration=${sourceAudioMeta.duration.toFixed(3)}s`);
  console.log(`start_time=${sourceAudioMeta.start_time}`);
  console.log(`peak=${sourceStats.peak} (${sourceStats.peakDb.toFixed(2)} dB)`);
  console.log(`rms=${sourceStats.rms.toFixed(2)} (${sourceStats.rmsDb.toFixed(2)} dB)`);
  console.log(``);
  console.log(`Output:`);
  console.log(`codec=${outputAudioMeta.codec}`);
  console.log(`sample_rate=${outputAudioMeta.sample_rate}`);
  console.log(`channels=${outputAudioMeta.channels}`);
  console.log(`duration=${outputAudioMeta.duration.toFixed(3)}s`);
  console.log(`start_time=${outputAudioMeta.start_time}`);
  console.log(`peak=${outputStats.peak} (${outputStats.peakDb.toFixed(2)} dB)`);
  console.log(`rms=${outputStats.rms.toFixed(2)} (${outputStats.rmsDb.toFixed(2)} dB)`);
  console.log(``);
  console.log(`Compared clip:`);
  console.log(`start=${clipStart}s`);
  console.log(`end=${(clipStart + durationToCompare).toFixed(3)}s`);
  console.log(`duration=${durationToCompare.toFixed(3)}s`);
  console.log(``);
  console.log(`samples_compared=${comparison.samplesCompared}`);
  console.log(`sample_length_diff=${comparison.lengthDiff}`);
  console.log(`max_abs_difference=${comparison.maxAbsDifference}`);
  console.log(`mean_abs_difference=${comparison.meanAbsDifference.toFixed(4)}`);
  console.log(`identical_pcm=${comparison.identicalPcm}`);
  console.log(``);
  console.log(`==========================================\n`);

  // Cleanup temp pcm
  await fs.unlink(sourcePcmPath).catch(() => {});
  await fs.unlink(outputPcmPath).catch(() => {});

  return {
    sourceAudioMeta,
    outputAudioMeta,
    sourceStats,
    outputStats,
    comparison,
  };
}

if (process.argv[1] && process.argv[1].endsWith('test_audio_identity.js')) {
  const args = process.argv.slice(2);
  const src = args[0] || 'temp/test_h264_aac.mp4';
  const out = args[1];
  const start = Number(args[2] || 0);
  const dur = Number(args[3] || 0);

  if (!out) {
    console.log('Usage: node scripts/test_audio_identity.js <sourcePath> <outputPath> [clipStart] [clipDuration]');
    process.exit(0);
  }

  runAudioIdentityTest({
    sourcePath: src,
    outputPath: out,
    clipStart: start,
    clipDuration: dur,
  }).catch((err) => {
    console.error('Error running audio identity test:', err);
    process.exit(1);
  });
}
