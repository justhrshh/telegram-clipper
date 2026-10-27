import path from 'node:path';
import fs from 'node:fs/promises';
import { processVerticalClip, createExactClip, probeMedia } from '../src/services/videoProcessor.js';
import { probeAudio } from '../src/services/video/audioPreservation.js';

async function main() {
  console.log('=== STARTING AUDIO PRESERVATION REGRESSION TEST ===\n');

  const sourcePath = path.resolve('temp/test_h264_aac.mp4');
  const outDir = path.resolve('temp/test_audio_out');
  await fs.mkdir(outDir, { recursive: true });

  const verticalOut = path.join(outDir, 'vertical_out.mp4');
  const exactOut = path.join(outDir, 'exact_out.mp4');

  // Clean old test files
  await fs.unlink(verticalOut).catch(() => {});
  await fs.unlink(exactOut).catch(() => {});

  // Test 1: Transform Path (Vertical 9:16 NVENC + Audio Copy)
  console.log('--- TEST 1: TRANSFORM PATH (processVerticalClip) ---');
  const vertResult = await processVerticalClip({
    sourcePath,
    outputPath: verticalOut,
    startSeconds: 0,
    endSeconds: 10,
    jobId: 'test-vert-audio',
    ratio: 'vertical',
    isSourceTrimmed: true,
  });

  console.log('\nVertical Result audio copy verified:', vertResult.audioVerification?.audio_copy);
  if (!vertResult.audioVerification?.audio_copy) {
    throw new Error('Test 1 FAILED: audio_copy is not true!');
  }

  // Test 2: Exact Clip Stream Copy
  console.log('\n--- TEST 2: STREAM-COPY PATH (createExactClip) ---');
  await createExactClip({
    sourcePath,
    outputPath: exactOut,
    startSeconds: 0,
    duration: 10,
    jobId: 'test-exact-audio',
  });

  const exactAudio = await probeAudio(exactOut, 'probe-exact');
  console.log('\nExact Clip Output Audio:', exactAudio);

  // Test 3: Fallback Path (Opus audio converted to AAC without filters)
  console.log('\n--- TEST 3: FALLBACK PATH (Incompatible Opus -> AAC) ---');
  const opusSourcePath = path.resolve('temp/test_downloader_verify/source.mp4');
  const fallbackOut = path.join(outDir, 'fallback_out.mp4');
  await fs.unlink(fallbackOut).catch(() => {});

  const fallbackResult = await processVerticalClip({
    sourcePath: opusSourcePath,
    outputPath: fallbackOut,
    startSeconds: 0,
    endSeconds: 5,
    jobId: 'test-fallback-audio',
    ratio: 'vertical',
    isSourceTrimmed: false,
  });

  console.log('\nFallback Result audio copy:', fallbackResult.audioVerification?.audio_copy);
  if (fallbackResult.audioVerification?.audio_copy !== false) {
    throw new Error('Test 3 FAILED: audio_copy should be false for fallback!');
  }
  if (fallbackResult.audioVerification?.output?.codec !== 'aac') {
    throw new Error('Test 3 FAILED: output codec should be aac for fallback!');
  }

  console.log('\n=== ALL AUDIO PRESERVATION TESTS PASSED SUCCESSFULLY! ===');
}

main().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
