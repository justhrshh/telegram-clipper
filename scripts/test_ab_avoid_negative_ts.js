import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runAudioIdentityTest, probeAudioStream } from './test_audio_identity.js';

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}): ${stderr}`));
    });
    proc.on('error', reject);
  });
}

async function main() {
  console.log('=== CONTROLLED A/B TEST: -avoid_negative_ts make_zero ===\n');

  const source = path.resolve('temp/test_h264_aac.mp4');
  const workDir = path.resolve('temp/ab_test_work');
  await fs.mkdir(workDir, { recursive: true });

  const outA = path.join(workDir, 'out_with_make_zero.mp4');
  const outB = path.join(workDir, 'out_WITHOUT_make_zero.mp4');

  await fs.unlink(outA).catch(() => {});
  await fs.unlink(outB).catch(() => {});

  const clipStart = 2;
  const clipDuration = 5;

  // TEST A: WITH -avoid_negative_ts make_zero
  console.log('Running Test A (WITH -avoid_negative_ts make_zero)...');
  const argsA = [
    '-v', 'error', '-y',
    '-ss', String(clipStart),
    '-i', source,
    '-t', String(clipDuration),
    '-vf', 'scale=1080:1920:flags=lanczos,setsar=1',
    '-c:v', 'h264_nvenc',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:a', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outA
  ];
  await runFfmpeg(argsA);

  // TEST B: WITHOUT -avoid_negative_ts make_zero
  console.log('Running Test B (WITHOUT -avoid_negative_ts make_zero)...');
  const argsB = [
    '-v', 'error', '-y',
    '-ss', String(clipStart),
    '-i', source,
    '-t', String(clipDuration),
    '-vf', 'scale=1080:1920:flags=lanczos,setsar=1',
    '-c:v', 'h264_nvenc',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outB
  ];
  await runFfmpeg(argsB);

  console.log('\n================ TEST A RESULTS (WITH make_zero) ================');
  const resultA = await runAudioIdentityTest({
    sourcePath: source,
    outputPath: outA,
    clipStart,
    clipDuration,
  });

  console.log('\n================ TEST B RESULTS (WITHOUT make_zero) ================');
  const resultB = await runAudioIdentityTest({
    sourcePath: source,
    outputPath: outB,
    clipStart,
    clipDuration,
  });

  console.log('=== COMPARISON SUMMARY ===');
  console.log(`Test A (with make_zero): max_abs_diff=${resultA.comparison.maxAbsDifference}, identical=${resultA.comparison.identicalPcm}`);
  console.log(`Test B (without make_zero): max_abs_diff=${resultB.comparison.maxAbsDifference}, identical=${resultB.comparison.identicalPcm}`);
}

main().catch(err => {
  console.error('A/B test failed:', err);
  process.exit(1);
});
