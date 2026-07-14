#!/usr/bin/env node
/**
 * M8.5 eval harness — speech WAV generation for fake-mic injection.
 *
 * Synthesizes every utterance in eval/utterances.json to
 * eval/audio/<id>.wav via Windows System.Speech (SAPI), requesting
 * 24kHz 16-bit mono PCM directly (SpeechAudioFormatInfo resamples the voice
 * internally, so no post-conversion is needed). Also writes silence.wav
 * (3s of digital silence) for the graceful-silent-turn test.
 *
 * Usage: node eval/tts.mjs [--force]
 * Skips WAVs that already exist unless --force.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, parseWav } from './lib.mjs';

const AUDIO_DIR = path.join(EVAL_DIR, 'audio');
const force = process.argv.includes('--force');

mkdirSync(AUDIO_DIR, { recursive: true });

const catalog = JSON.parse(readFileSync(path.join(EVAL_DIR, 'utterances.json'), 'utf8'));
const jobs = catalog.utterances.filter(
  (u) => force || !existsSync(path.join(AUDIO_DIR, `${u.id}.wav`)),
);

// ---------------------------------------------------------------------------
// 1. silence.wav — 3s of zeros @ 24kHz 16-bit mono (no TTS involved)
// ---------------------------------------------------------------------------
const silencePath = path.join(AUDIO_DIR, 'silence.wav');
if (force || !existsSync(silencePath)) {
  const seconds = 3;
  const dataLen = 24_000 * 2 * seconds;
  const wav = Buffer.alloc(44 + dataLen); // zero-filled data == silence
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataLen, 40);
  writeFileSync(silencePath, wav);
  console.log(`wrote ${silencePath}`);
}

// ---------------------------------------------------------------------------
// 2. TTS via one PowerShell invocation for all pending utterances
// ---------------------------------------------------------------------------
if (jobs.length === 0) {
  console.log('all TTS wavs present (use --force to regenerate)');
} else {
  const manifestPath = path.join(AUDIO_DIR, '_tts-jobs.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      jobs.map((u) => ({ id: u.id, text: u.text, out: path.join(AUDIO_DIR, `${u.id}.wav`) })),
    ),
  );
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$jobs = Get-Content -Raw '${manifestPath.replace(/'/g, "''")}' | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 1
try {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
} catch {
  Write-Host 'FALLBACK: 24kHz format rejected, using 22.05kHz'
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
}
foreach ($job in $jobs) {
  $synth.SetOutputToWaveFile($job.out, $fmt)
  $synth.Speak($job.text)
  $synth.SetOutputToNull()
  Write-Host ("wrote " + $job.out)
}
$synth.Dispose()
`;
  const scriptPath = path.join(AUDIO_DIR, '_tts.ps1');
  writeFileSync(scriptPath, script, { encoding: 'utf8' });
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      encoding: 'utf8',
      timeout: 300_000,
    },
  );
  process.stdout.write(out);
  rmSync(scriptPath, { force: true });
  rmSync(manifestPath, { force: true });
}

// ---------------------------------------------------------------------------
// 3. Verify: every wav parses as 16-bit PCM and report durations
// ---------------------------------------------------------------------------
console.log('\nverification:');
for (const u of [...catalog.utterances.map((x) => x.id), 'silence']) {
  const p = path.join(AUDIO_DIR, `${u}.wav`);
  if (!existsSync(p)) {
    console.log(`  MISSING ${u}.wav`);
    continue;
  }
  const { sampleRate, samples } = parseWav(readFileSync(p));
  const seconds = samples.length / sampleRate;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const warn =
    u !== 'silence' && seconds > 3.2 ? '  <-- WARNING: longer than the ~3.5s hold window' : '';
  console.log(`  ${u}.wav: ${sampleRate}Hz ${seconds.toFixed(2)}s peak=${peak.toFixed(3)}${warn}`);
}
