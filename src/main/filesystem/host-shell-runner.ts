import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { hostFs } from './host-fs';
import { hostFsPromises } from './host-fs';

const { constants } = hostFs;
const { access, mkdir } = hostFsPromises;

const SHELL = '/bin/zsh';
const OUTPUT_LIMIT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationSignal?: NodeJS.Signals;
  diagnostic?: string;
}

export interface HostShellPaths {
  taskRoot: string;
  source: string;
  workspace: string;
  home: string;
  temp: string;
}

/**
 * Runs helper commands as ordinary host processes.
 *
 * There is intentionally no OS sandbox here: commands have the same filesystem
 * and network access as the Buddy process. The synthetic HOME and explicit
 * environment prevent shell startup files and inherited credentials from
 * becoming ambient command inputs, but they are not a security boundary.
 */
export class HostShellRunner {
  private availabilityPromise: Promise<void> | null = null;

  assertAvailable(): Promise<void> {
    this.availabilityPromise ??= this.checkAvailability();
    return this.availabilityPromise;
  }

  async prepare(paths: HostShellPaths): Promise<void> {
    await Promise.all([
      mkdir(paths.workspace, { recursive: true }),
      mkdir(paths.home, { recursive: true }),
      mkdir(paths.temp, { recursive: true }),
    ]);
  }

  async runSource(
    paths: HostShellPaths,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    return this.runAt(paths, paths.source, script, cwdRelative, signal);
  }

  async runStaged(
    paths: HostShellPaths,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    return this.runAt(paths, paths.workspace, script, cwdRelative, signal);
  }

  private async runAt(
    paths: HostShellPaths,
    root: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    await this.assertAvailable();
    if (script.length === 0 || script.length > 32_000)
      throw new Error('shell script is empty or too large');
    const cwd = resolveContainedPath(root, cwdRelative);
    await access(cwd, constants.R_OK);
    return runProcess(SHELL, ['-dfc', script], {
      cwd,
      env: {
        HOME: paths.home,
        TMPDIR: paths.temp,
        PATH: `${join(paths.source, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin`,
        NODE_PATH: join(paths.source, 'node_modules'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PWD: cwd,
        BUDDY_TASK_ROOT: paths.taskRoot,
        BUDDY_SOURCE_ROOT: paths.source,
        BUDDY_STAGED_ROOT: paths.workspace,
        BUDDY_EXECUTION_MODE: 'host',
      },
      signal,
    });
  }

  private async checkAvailability(): Promise<void> {
    if (process.platform !== 'darwin')
      throw new Error('filesystem execution currently requires macOS');
    await access(SHELL, constants.X_OK);
  }
}

interface ProcessOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ShellRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', onAbort);
      terminate('SIGKILL');
      reject(error);
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length + chunk.length > OUTPUT_LIMIT_BYTES) {
        finishError(new Error('shell output exceeded the 128 KB safety limit'));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => finishError(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', onAbort);
      const exitCode = code ?? exitCodeForSignal(signal);
      const terminationSignal = signal ?? inferSignalFromExitCode(exitCode);
      resolvePromise({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        ...(terminationSignal
          ? {
              terminationSignal,
              diagnostic: signalDiagnostic(terminationSignal, exitCode),
            }
          : {}),
      });
    });
    const onAbort = (): void => {
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 1_000).unref();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      finishError(new Error('shell command exceeded the two-minute limit'));
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
    if (options.signal.aborted) onAbort();
  });
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

function inferSignalFromExitCode(exitCode: number): NodeJS.Signals | undefined {
  const signalNumber = exitCode - 128;
  if (signalNumber <= 0) return undefined;
  return Object.entries(osConstants.signals).find(([, value]) => value === signalNumber)?.[0] as
    NodeJS.Signals | undefined;
}

function signalDiagnostic(signal: NodeJS.Signals, exitCode: number): string {
  const prefix = `the shell process was terminated by ${signal} (exit ${exitCode}); do not retry the same command unchanged.`;
  if (signal !== 'SIGKILL') return prefix;
  return (
    `${prefix} On macOS, directly executing a private binary inside another application's ` +
    "`Contents/Frameworks` or `Contents/Resources` directory can violate that app's signed-parent " +
    "launch constraint. Use the application's documented CLI or signed `Contents/MacOS` entrypoint instead."
  );
}

function resolveContainedPath(root: string, cwdRelative: string): string {
  const candidate = resolve(root, cwdRelative || '.');
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(prefix))
    throw new Error('working directory escapes the authorized folder');
  return candidate;
}
