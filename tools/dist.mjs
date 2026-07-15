#!/usr/bin/env node
/** Build and package Buddy for the current desktop platform. */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateMacReleaseReadiness } from '../build/mac-release-readiness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const productionMacRelease = process.env.BUDDY_RELEASE === '1';

if (productionMacRelease && process.platform !== 'darwin') {
  throw new Error('BUDDY_RELEASE=1 is supported only for a macOS distribution build');
}
if (productionMacRelease) {
  const identities = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  validateMacReleaseReadiness(
    process.env,
    [identities.stdout, identities.stderr].filter(Boolean).join('\n'),
  );
}

runNpm(['run', 'build']);
run(process.execPath, [path.join(ROOT, 'build', 'make-icon.mjs')]);

if (process.platform === 'darwin') {
  // Repositories under iCloud/File Provider can automatically attach Finder
  // metadata to app bundles after signing, invalidating the resource seal.
  // Build the app and artifacts on the local temp volume, then copy only the
  // finished DMG/ZIP back into the repository's ignored dist directory.
  const staging = mkdtempSync(path.join(tmpdir(), 'buddy-dist-'));
  try {
    const builderArgs = [
      'exec',
      '--',
      'electron-builder',
      '--mac',
      '--publish',
      'never',
      `--config.directories.output=${staging}`,
    ];
    if (productionMacRelease) builderArgs.push('--config.forceCodeSigning=true');
    runNpm(builderArgs);
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
  runNpm(['exec', '--', 'electron-builder', '--win', '--publish', 'never']);
} else {
  throw new Error('Buddy distribution packaging is supported on macOS and Windows');
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    run(process.execPath, [npmCli, ...args]);
    return;
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
