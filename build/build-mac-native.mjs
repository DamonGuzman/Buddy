#!/usr/bin/env node
/** Build Buddy's same-process macOS privacy bridge as a universal Node-API addon. */

import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const buildDir = dirname(fileURLToPath(import.meta.url));
const source = join(buildDir, 'macos-screen-permission.c');
const outputDir = join(buildDir, 'native');
const output = join(outputDir, 'macos-screen-permission.node');
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  'xcrun',
  [
    'clang',
    '-bundle',
    '-O2',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=12.0',
    '-undefined',
    'dynamic_lookup',
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
  throw new Error(`building macOS privacy bridge failed${detail ? `:\n${detail}` : ''}`);
}
console.log(`[mac-native] built ${output}`);
