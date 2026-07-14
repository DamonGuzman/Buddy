#!/usr/bin/env node
/** Build and package Buddy for the current desktop platform. */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run(npm, ['run', 'build']);
run(process.execPath, [path.join(ROOT, 'build', 'make-icon.mjs')]);

if (process.platform === 'darwin') {
  // Repositories under iCloud/File Provider can automatically attach Finder
  // metadata to app bundles after signing, invalidating the resource seal.
  // Build the app and artifacts on the local temp volume, then copy only the
  // finished DMG/ZIP back into the repository's ignored dist directory.
  const staging = mkdtempSync(path.join(tmpdir(), 'buddy-dist-'));
  try {
    run(npm, [
      'exec',
      '--',
      'electron-builder',
      '--mac',
      `--config.directories.output=${staging}`,
    ]);
    const destination = path.join(ROOT, 'dist');
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(staging)) {
      if (!/\.(?:dmg|zip|blockmap|yml)$/i.test(name)) continue;
      copyFileSync(path.join(staging, name), path.join(destination, name));
      console.log(`[dist] copied ${name}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} else if (process.platform === 'win32') {
  run(npm, ['exec', '--', 'electron-builder', '--win']);
} else {
  throw new Error('Buddy distribution packaging is supported on macOS and Windows');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
