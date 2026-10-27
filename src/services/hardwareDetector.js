import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

let cachedDetection = null;
let lastDetectionTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Runs a live hardware capability check on FFmpeg to determine whether NVIDIA NVENC (h264_nvenc)
 * is currently available and functional on this host.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceCheck=false] - If true, bypasses the in-memory cache
 * @returns {Promise<{
 *   encoder: 'h264_nvenc' | 'libx264',
 *   isGpuAvailable: boolean,
 *   reason: string,
 *   detectedAt: number
 * }>}
 */
export async function detectVideoEncoder({ forceCheck = false } = {}) {
  const now = Date.now();
  if (!forceCheck && cachedDetection && now - lastDetectionTime < CACHE_TTL_MS) {
    return cachedDetection;
  }

  const probeArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:rate=1',
    '-frames:v',
    '1',
    '-c:v',
    'h264_nvenc',
    '-f',
    'null',
    '-',
  ];

  let probeStderr = '';
  let isGpuAvailable = false;
  let failureReason = '';

  try {
    const exitCode = await new Promise((resolve) => {
      const proc = spawn('ffmpeg', probeArgs, { windowsHide: true });

      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        resolve(-1);
      }, 3000);

      proc.stderr.on('data', (d) => {
        probeStderr += d.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        failureReason = err.message;
        resolve(-1);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    if (exitCode === 0) {
      isGpuAvailable = true;
    } else {
      isGpuAvailable = false;
      if (probeStderr.includes('CUDA_ERROR_NO_DEVICE') || probeStderr.includes('no CUDA-capable device')) {
        failureReason = 'CUDA_ERROR_NO_DEVICE (GPU in Eco/Phantom mode or inactive)';
      } else if (probeStderr.includes('Cannot load nvcuda.dll') || probeStderr.includes('driver')) {
        failureReason = 'NVIDIA driver or nvcuda.dll not accessible';
      } else {
        failureReason = `Probe exited with code ${exitCode}: ${probeStderr.split(/[\r\n]+/).slice(-2).join(' ')}`;
      }
    }
  } catch (err) {
    isGpuAvailable = false;
    failureReason = err.message;
  }

  const selectedEncoder = isGpuAvailable ? 'h264_nvenc' : 'libx264';

  logger.info(
    `[HARDWARE_DETECTION] VIDEO_ENCODER_SELECTED=${selectedEncoder} | ` +
    `GPU_ENCODER_AVAILABLE=${isGpuAvailable}${!isGpuAvailable ? ` | Reason: ${failureReason}` : ''}`
  );

  cachedDetection = {
    encoder: selectedEncoder,
    isGpuAvailable,
    reason: isGpuAvailable ? 'NVIDIA NVENC active' : failureReason,
    detectedAt: now,
  };
  lastDetectionTime = now;

  return cachedDetection;
}
