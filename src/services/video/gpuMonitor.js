import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

/**
 * Queries nvidia-smi for current GPU utilization and VRAM statistics.
 *
 * @param {string} [jobId='system'] - Context job ID
 * @returns {Promise<{ utilization: number, vramUsedMb: number, vramFreeMb: number }>}
 */
export async function getGpuStats(jobId = 'system') {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.free --format=csv,noheader,nounits',
      { windowsHide: true, timeout: 2000 }
    );

    const parts = stdout.trim().split(',').map((p) => Number(p.trim()));
    const utilization = Number.isNaN(parts[0]) ? 0 : parts[0];
    const vramUsedMb = Number.isNaN(parts[1]) ? 0 : parts[1];
    const vramFreeMb = Number.isNaN(parts[2]) ? 6144 : parts[2];

    logger.info(
      `[${jobId}] [GPU]\n` +
      `utilization=${utilization}%\n` +
      `vram_used=${vramUsedMb}MB\n` +
      `vram_free=${vramFreeMb}MB`
    );

    return { utilization, vramUsedMb, vramFreeMb };
  } catch (err) {
    logger.debug(`[${jobId}] nvidia-smi check skipped or unavailable: ${err.message}`);
    return { utilization: 0, vramUsedMb: 0, vramFreeMb: 6144 };
  }
}

/**
 * Checks GPU VRAM availability before starting a GPU-heavy encode.
 * If VRAM is dangerously low (< 500MB free), pauses briefly to let ongoing encodes finish.
 *
 * @param {string} [jobId='gpu-guard']
 * @param {number} [minFreeMb=500]
 * @param {number} [maxWaitMs=5000]
 */
export async function ensureGpuMemoryAvailable(jobId = 'gpu-guard', minFreeMb = 500, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const stats = await getGpuStats(jobId);
    if (stats.vramFreeMb >= minFreeMb) {
      return stats;
    }
    logger.warn(
      `[${jobId}] [GPU_THROTTLE] Low VRAM detected (${stats.vramFreeMb}MB free < ${minFreeMb}MB required). Pausing 1s for pending encode release...`
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await getGpuStats(jobId);
}
