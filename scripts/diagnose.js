import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoderCapabilities } from '../src/services/video/encoderCapabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(PROJECT_ROOT, '.venv/Scripts/python.exe');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'python/transcription.py');

async function runDiagnosis() {
  console.log('\n=============================================================');
  console.log('  TELEGRAM CLIPPER — FULL PIPELINE SYSTEM DIAGNOSIS');
  console.log('=============================================================');

  // 1. Python & CTranslate2 GPU Diagnostic
  await new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, [SCRIPT_PATH, '--diagnose'], { stdio: 'inherit' });
    proc.on('close', resolve);
    proc.on('error', (err) => {
      console.error('Failed to run Python diagnostic:', err.message);
      resolve();
    });
  });

  // 2. Video Encoder & FFmpeg NVENC Diagnostic
  console.log('[VIDEO ENCODER & HARDWARE ACCELERATION]');
  try {
    const caps = await getEncoderCapabilities({ forceCheck: true });
    console.log(`  Preferred Encoder:  ${caps.preferredEncoder}`);
    console.log(`  NVENC Compiled:     ${caps.nvenc}`);
    console.log(`  CUDA HWACCEL:       ${caps.cuda}`);
    console.log(`  GPU Functional:     ${caps.gpuAvailable}`);
    console.log(`  Status Note:        ${caps.reason}`);
  } catch (err) {
    console.error('  Failed to probe video encoder:', err.message);
  }

  console.log('\n=============================================================\n');
}

runDiagnosis().catch(console.error);
