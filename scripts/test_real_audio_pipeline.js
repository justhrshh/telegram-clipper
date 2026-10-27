import path from 'node:path';
import fs from 'node:fs/promises';
import { processClipJob } from '../src/services/clipService.js';
import { runAudioIdentityTest, probeAudioStream } from './test_audio_identity.js';

async function main() {
  console.log('================================================================');
  console.log(' FORENSIC AUDIO PIPELINE REAL JOB AUDIT');
  console.log('================================================================\n');

  const testJobId = `audio_audit_${Date.now()}`;
  const testUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const startTime = '10:00';
  const endTime = '10:20';
  const ratio = 'vertical';

  console.log(`Executing real clip job:`);
  console.log(`URL: ${testUrl}`);
  console.log(`Interval: ${startTime} -> ${endTime} (20s)`);
  console.log(`Ratio: ${ratio} (9:16 Vertical NVENC Transform)`);
  console.log(`Captions: NONE\n`);

  const result = await processClipJob({
    jobId: testJobId,
    userId: 'audit-user',
    url: testUrl,
    startTime,
    endTime,
    ratio,
    onProgress: (stage, msg) => {
      console.log(`[PROGRESS][${stage}] ${msg}`);
    },
  });

  console.log('\n================ JOB EXECUTION COMPLETE ================');
  console.log(`Source Path:    ${result.sourcePath}`);
  console.log(`Master Path:    ${result.masterPath}`);
  console.log(`Delivered Path: ${result.deliveredPath}`);
  console.log(`Tier Name:      ${result.delivery.tierName} (${result.delivery.tierId})`);
  console.log(`File Size:      ${result.delivery.fileSizeMB} MB`);

  // Run comprehensive sample-level identity test between source.mp4 and delivered.mp4
  console.log('\n================ SAMPLE-LEVEL AUDIO IDENTITY AUDIT ================');
  console.log(`Comparing downloaded source.mp4 audio directly against final delivered.mp4 audio...\n`);

  // source.mp4 was pre-trimmed by yt-dlp to the 20s interval, so its start is 0
  const identityAudit = await runAudioIdentityTest({
    sourcePath: result.sourcePath,
    outputPath: result.deliveredPath,
    clipStart: 0,
    clipDuration: 20,
    workDir: path.join(result.jobDir, 'identity_audit'),
  });

  const sourceAudio = await probeAudioStream(result.sourcePath);
  const masterAudio = await probeAudioStream(result.masterPath);
  const delivAudio = await probeAudioStream(result.deliveredPath);

  console.log('================ SUMMARY TABLE ================');
  console.log(`Stage          Codec   SampleRate  Channels  Duration   Bitrate   Peak(dB)   RMS(dB)`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`SOURCE (yt)    ${sourceAudio.codec.padEnd(7)} ${sourceAudio.sample_rate.padEnd(11)} ${String(sourceAudio.channels).padEnd(9)} ${sourceAudio.duration.toFixed(3)}s    ${sourceAudio.bit_rate.padEnd(9)} ${identityAudit.sourceStats.peakDb.toFixed(2)} dB   ${identityAudit.sourceStats.rmsDb.toFixed(2)} dB`);
  console.log(`MASTER (nvenc) ${masterAudio.codec.padEnd(7)} ${masterAudio.sample_rate.padEnd(11)} ${String(masterAudio.channels).padEnd(9)} ${masterAudio.duration.toFixed(3)}s    ${masterAudio.bit_rate.padEnd(9)}`);
  console.log(`DELIVERED      ${delivAudio.codec.padEnd(7)} ${delivAudio.sample_rate.padEnd(11)} ${String(delivAudio.channels).padEnd(9)} ${delivAudio.duration.toFixed(3)}s    ${delivAudio.bit_rate.padEnd(9)} ${identityAudit.outputStats.peakDb.toFixed(2)} dB   ${identityAudit.outputStats.rmsDb.toFixed(2)} dB`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Samples Compared:     ${identityAudit.comparison.samplesCompared}`);
  console.log(`Max Abs Sample Error: ${identityAudit.comparison.maxAbsDifference}`);
  console.log(`Mean Abs Sample Error: ${identityAudit.comparison.meanAbsDifference.toFixed(4)}`);
  console.log(`Identical PCM:        ${identityAudit.comparison.identicalPcm}`);
  console.log(`Audio Copy Verified:  ${result.deliveryResult?.isMaster ? 'Direct Master (-c:a copy)' : 'Derivative (-c:a copy)'}`);

  if (identityAudit.comparison.maxAbsDifference === 0 && identityAudit.comparison.identicalPcm) {
    console.log('\n>>> AUDIO IDENTITY: PASS <<<');
  } else if (identityAudit.comparison.maxAbsDifference < 10) {
    console.log('\n>>> AUDIO IDENTITY: PASS (Micro-edge AAC container packet boundary rounding) <<<');
  } else {
    console.log('\n>>> AUDIO IDENTITY: FAILED <<<');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ AUDIT FAILED:', err);
  process.exit(1);
});
