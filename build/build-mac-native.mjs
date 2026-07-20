#!/usr/bin/env node
/** Build Buddy's same-process macOS integration bridge as a universal Node-API addon. */

import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const buildDir = dirname(fileURLToPath(import.meta.url));
const source = join(buildDir, 'macos-native.m');
const outputDir = join(buildDir, 'native');
const output = join(outputDir, 'buddy-macos-native.node');
mkdirSync(outputDir, { recursive: true });

function readSdkValue(argument, label) {
  const result = spawnSync('xcrun', ['--sdk', 'macosx', argument], { encoding: 'utf8' });
  const value = result.stdout?.trim();
  if (result.status !== 0 || !value) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`locating the macOS SDK ${label} failed${detail ? `:\n${detail}` : ''}`);
  }
  return value;
}

const sdkPath = readSdkValue('--show-sdk-path', 'path');
const sdkVersion = readSdkValue('--show-sdk-version', 'version');
const sdkMajorVersion = Number.parseInt(sdkVersion.split('.')[0] ?? '', 10);
if (!Number.isInteger(sdkMajorVersion) || sdkMajorVersion < 26) {
  throw new Error(
    `Buddy's native Liquid Glass bridge requires the macOS 26 SDK or newer; found ${sdkVersion}`,
  );
}

const result = spawnSync(
  'xcrun',
  [
    '--sdk',
    'macosx',
    'clang',
    '-bundle',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Werror=unguarded-availability-new',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=12.0',
    '-isysroot',
    sdkPath,
    '-fobjc-arc',
    '-fblocks',
    '-undefined',
    'dynamic_lookup',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    source,
    '-o',
    output,
  ],
  { encoding: 'utf8' },
);
if (result.status !== 0) {
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  throw new Error(`building macOS integration bridge failed${detail ? `:\n${detail}` : ''}`);
}
console.log(`[mac-native] built ${output}`);
