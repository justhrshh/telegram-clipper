import { spawn } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/env.js';

let cachedCapabilities = null;
let lastDetectionTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds cache TTL

/**
 * Runs a subprocess with a timeout and returns its stdout and stderr.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} [timeoutMs=4000]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCommand(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(cmd, args, { windowsHide: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {}
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n[Process timed out]' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Probes static FFmpeg build features (encoders, hwaccels, decoders, filters).
 *
 * @returns {Promise<{ hasNvenc: boolean, hasCuda: boolean, hasNvdec: boolean, hasScaleNpp: boolean }>}
 */
async function probeFfmpegBuildFeatures() {
  const [encRes, hwRes, decRes, filtRes] = await Promise.all([
    runCommand('ffmpeg', ['-encoders']),
    runCommand('ffmpeg', ['-hwaccels']),
    runCommand('ffmpeg', ['-decoders']),
    runCommand('ffmpeg', ['-filters']),
  ]);

  const encOut = (encRes.stdout + encRes.stderr).toLowerCase();
  const hwOut = (hwRes.stdout + hwRes.stderr).toLowerCase();
  const decOut = (decRes.stdout + decRes.stderr).toLowerCase();
  const filtOut = (filtRes.stdout + filtRes.stderr).toLowerCase();

  return {
    hasNvenc: encOut.includes('h264_nvenc'),
    hasCuda: hwOut.includes('cuda'),
    hasNvdec: decOut.includes('h264_cuvid') || encOut.includes('nvdec'),
    hasScaleNpp: filtOut.includes('scale_npp'),
  };
}

/**
 * Runs a live hardware capability check on FFmpeg by executing a 1-frame NVENC encode.
 *
 * @returns {Promise<{ isFunctional: boolean, reason: string }>}
 */
async function probeLiveNvencExecution() {
  const probeArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=256x256:rate=1',
    '-frames:v',
    '1',
    '-c:v',
    'h264_nvenc',
    '-f',
    'null',
    '-',
  ];

  const result = await runCommand('ffmpeg', probeArgs, 3500);

  if (result.exitCode === 0) {
    return {
      isFunctional: true,
      reason: 'NVIDIA NVENC hardware encoder active and verified',
    };
  }

  const errText = result.stderr;
  let reason = 'NVENC test execution failed';

  if (errText.includes('CUDA_ERROR_NO_DEVICE') || errText.includes('no CUDA-capable device')) {
    reason = 'CUDA_ERROR_NO_DEVICE (NVIDIA GPU in Eco/Phantom mode, on battery, or disabled)';
  } else if (errText.includes('Cannot load nvcuda.dll') || errText.includes('driver')) {
    reason = 'NVIDIA driver or nvcuda.dll not accessible';
  } else if (errText.includes('Device creation failed')) {
    reason = 'NVIDIA device creation failed';
  } else {
    const lastLines = errText.split(/[\r\n]+/).filter(Boolean).slice(-2).join('; ');
    reason = `NVENC error code ${result.exitCode}: ${lastLines || 'unknown'}`;
  }

  return {
    isFunctional: false,
    reason,
  };
}

/**
 * Invalidates the cached encoder capabilities forcing a fresh hardware probe on next check.
 */
export function invalidateCapabilitiesCache() {
  cachedCapabilities = null;
  lastDetectionTime = 0;
}

/**
 * Inspects system and FFmpeg capabilities, returning structured hardware availability.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceCheck=false]
 * @returns {Promise<{
 *   nvenc: boolean,
 *   cuda: boolean,
 *   nvdec: boolean,
 *   scaleNpp: boolean,
 *   gpuAvailable: boolean,
 *   preferredEncoder: 'h264_nvenc' | 'libx264',
 *   reason: string,
 *   details: object,
 *   detectedAt: number
 * }>}
 */
export async function getEncoderCapabilities({ forceCheck = false } = {}) {
  const now = Date.now();
  if (!forceCheck && cachedCapabilities && (now - lastDetectionTime < CACHE_TTL_MS)) {
    return cachedCapabilities;
  }

  // 1. Probe static build support
  const buildFeatures = await probeFfmpegBuildFeatures();

  // 2. Probe live hardware functional capability if NVENC is compiled
  let liveCheck = { isFunctional: false, reason: 'h264_nvenc not compiled in FFmpeg' };
  if (buildFeatures.hasNvenc) {
    liveCheck = await probeLiveNvencExecution();
  }

  // 3. Select preferred video encoder
  let preferredEncoder = 'libx264';
  let selectionReason = '';

  const configuredPreference = config.videoEncoder; // 'auto', 'nvenc', 'cpu'

  if (configuredPreference === 'cpu') {
    preferredEncoder = 'libx264';
    selectionReason = 'Forced CPU encoding via VIDEO_ENCODER=cpu';
  } else if (configuredPreference === 'nvenc') {
    if (liveCheck.isFunctional) {
      preferredEncoder = 'h264_nvenc';
      selectionReason = 'NVIDIA NVENC forced and verified';
    } else {
      preferredEncoder = 'libx264';
      selectionReason = `VIDEO_ENCODER=nvenc requested but GPU unavailable: ${liveCheck.reason}. Falling back to libx264.`;
      logger.warn(`[ENCODER_WARNING] ${selectionReason}`);
    }
  } else {
    // 'auto' mode
    if (liveCheck.isFunctional) {
      preferredEncoder = 'h264_nvenc';
      selectionReason = 'NVIDIA NVENC active and selected (GPU acceleration)';
    } else {
      preferredEncoder = 'libx264';
      selectionReason = `GPU acceleration unavailable (${liveCheck.reason}). Selected high-performance CPU libx264.`;
    }
  }

  cachedCapabilities = {
    nvenc: buildFeatures.hasNvenc,
    cuda: buildFeatures.hasCuda,
    nvdec: buildFeatures.hasNvdec,
    scaleNpp: buildFeatures.hasScaleNpp,
    gpuAvailable: liveCheck.isFunctional,
    preferredEncoder,
    reason: selectionReason,
    details: {
      buildFeatures,
      liveCheck,
      configuredPreference,
    },
    detectedAt: now,
  };

  lastDetectionTime = now;
  return cachedCapabilities;
}

/**
 * Returns the currently preferred video encoder ('h264_nvenc' or 'libx264').
 *
 * @returns {Promise<'h264_nvenc' | 'libx264'>}
 */
export async function getPreferredVideoEncoder() {
  const caps = await getEncoderCapabilities();
  return caps.preferredEncoder;
}
