import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const workDir = mkdtempSync(join(tmpdir(), 'buddy-browser-e2e-'));
const outDir = join(workDir, 'bundle');
const userData = join(workDir, 'user-data');
const sentinel = join(workDir, 'complete');
symlinkSync(
  join(repo, 'node_modules'),
  join(workDir, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);

function run(command, args, env, timeout) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env,
    stdio: 'inherit',
    ...(timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' }),
  });
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`BROWSER_E2E FAIL child process exceeded ${timeout}ms`);
    process.exitCode = 1;
    return false;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

try {
  const env = {
    ...process.env,
    BUDDY_BROWSER_E2E_OUT_DIR: outDir,
    BUDDY_BROWSER_E2E_USER_DATA: userData,
    BUDDY_BROWSER_E2E_SENTINEL: sentinel,
  };
  const built = run(
    process.execPath,
    [
      join(repo, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      '--config',
      join(here, 'electron.vite.config.ts'),
    ],
    env,
  );
  if (built) {
    const completed = run(requireElectronBinary(repo), [join(outDir, 'main.js')], env, 60_000);
    if (completed && !existsSync(sentinel)) {
      console.error('BROWSER_E2E FAIL Electron exited without the completion sentinel');
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function requireElectronBinary(root) {
  const executable =
    process.platform === 'darwin'
      ? join(
          root,
          'node_modules',
          'electron',
          'dist',
          'Electron.app',
          'Contents',
          'MacOS',
          'Electron',
        )
      : process.platform === 'win32'
        ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
        : join(root, 'node_modules', 'electron', 'dist', 'electron');

  // Keeping this check explicit produces a useful error when Electron's postinstall was skipped.
  if (!existsSync(executable)) throw new Error(`Electron executable is missing: ${executable}`);
  return executable;
}
