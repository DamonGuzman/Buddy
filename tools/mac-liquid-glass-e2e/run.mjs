#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

if (process.platform !== 'darwin') {
  console.log('LIQUID_GLASS_E2E SKIP requires macOS');
  process.exit(0);
}

const systemVersion = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
if (systemVersion.status !== 0) {
  throw new Error(`reading the macOS version failed: ${systemVersion.stderr?.trim() ?? ''}`);
}
const macOSMajorVersion = Number.parseInt(systemVersion.stdout.trim().split('.')[0] ?? '', 10);
if (!Number.isInteger(macOSMajorVersion)) {
  throw new Error(`could not parse the macOS version: ${systemVersion.stdout.trim()}`);
}
if (macOSMajorVersion < 26) {
  console.log(
    `LIQUID_GLASS_E2E SKIP requires macOS 26 or newer; found ${systemVersion.stdout.trim()}`,
  );
  process.exit(0);
}

const electron = electronExecutable(repo);
const addon = join(repo, 'build', 'native', 'buddy-macos-native.node');
const workDir = mkdtempSync(join(tmpdir(), 'buddy-liquid-glass-e2e-'));
const sentinel = join(workDir, 'complete');

try {
  run(process.execPath, [join(repo, 'build', 'build-mac-native.mjs')], 120_000);
  if (!existsSync(addon)) throw new Error(`native bridge was not produced: ${addon}`);

  run(electron, [join(here, 'main.cjs')], 90_000, {
    BUDDY_LIQUID_GLASS_E2E_ADDON: addon,
    BUDDY_LIQUID_GLASS_E2E_SENTINEL: sentinel,
    BUDDY_LIQUID_GLASS_E2E_USER_DATA: join(workDir, 'user-data'),
  });
  if (!existsSync(sentinel)) {
    throw new Error('Electron exited without completing the Liquid Glass assertions');
  }
  console.log('LIQUID_GLASS_E2E PASS');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function run(command, args, timeout, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    timeout,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`command exceeded ${timeout}ms: ${command}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed with exit code ${result.status}: ${command}`);
  }
}

function electronExecutable(root) {
  const executable = join(
    root,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
  );
  if (!existsSync(executable)) {
    throw new Error(`Electron executable is missing: ${executable}`);
  }
  return executable;
}
