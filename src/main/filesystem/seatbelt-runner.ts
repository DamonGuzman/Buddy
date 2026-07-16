import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { hostFs, hostFsPromises } from './host-fs';

const { constants } = hostFs;
const { access, mkdir, readFile, rm, writeFile } = hostFsPromises;

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHELL = '/bin/zsh';
const OUTPUT_LIMIT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShellTaskPaths {
  taskRoot: string;
  source: string;
  workspace: string;
  home: string;
  temp: string;
  profile: string;
}

export class MacSeatbeltRunner {
  private selfTestPromise: Promise<void> | null = null;

  constructor(private readonly basePath: string) {}

  assertAvailable(): Promise<void> {
    this.selfTestPromise ??= this.runSelfTest();
    return this.selfTestPromise;
  }

  async prepare(paths: ShellTaskPaths): Promise<void> {
    await Promise.all([
      mkdir(paths.workspace, { recursive: true }),
      mkdir(paths.home, { recursive: true }),
      mkdir(paths.temp, { recursive: true }),
    ]);
    await writeFile(paths.profile, seatbeltProfile(paths), { mode: 0o600 });
  }

  async runSource(
    paths: ShellTaskPaths,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    return this.runAt(paths, paths.source, script, cwdRelative, signal);
  }

  async runStaged(
    paths: ShellTaskPaths,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    return this.runAt(paths, paths.workspace, script, cwdRelative, signal);
  }

  private async runAt(
    paths: ShellTaskPaths,
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
    return runProcess(SANDBOX_EXEC, ['-f', paths.profile, SHELL, '-dfc', script], {
      cwd,
      env: {
        HOME: paths.home,
        TMPDIR: paths.temp,
        PATH: `${join(paths.source, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin`,
        NODE_PATH: join(paths.source, 'node_modules'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PWD: cwd,
        BUDDY_SOURCE_ROOT: paths.source,
        BUDDY_STAGED_ROOT: paths.workspace,
        BUDDY_SANDBOX: 'seatbelt',
        BUDDY_NETWORK_DISABLED: '1',
      },
      signal,
    });
  }

  private async runSelfTest(): Promise<void> {
    if (process.platform !== 'darwin')
      throw new Error('filesystem execution currently requires macOS');
    await access(SANDBOX_EXEC, constants.X_OK);
    const root = join(this.basePath, '.seatbelt-self-test');
    const paths: ShellTaskPaths = {
      taskRoot: root,
      source: join(root, 'source'),
      workspace: join(root, 'workspace'),
      home: join(root, 'home'),
      temp: join(root, 'tmp'),
      profile: join(root, 'profile.sb'),
    };
    await rm(root, { recursive: true, force: true });
    await mkdir(paths.source, { recursive: true });
    await this.prepare(paths);
    const forbidden = join(root, 'must-not-exist');
    const controller = new AbortController();
    const result = await this.runUnchecked(
      paths,
      `printf safe > ok.txt; (printf unsafe > ${shellQuote(forbidden)}) 2>/dev/null || true; cat ok.txt`,
      paths.workspace,
      controller.signal,
    );
    const escaped = await readFile(forbidden, 'utf8').then(
      () => true,
      () => false,
    );
    await rm(root, { recursive: true, force: true });
    if (result.exitCode !== 0 || result.stdout.trim() !== 'safe' || escaped) {
      throw new Error('macOS sandbox self-test failed; shell execution remains disabled');
    }
  }

  private runUnchecked(
    paths: ShellTaskPaths,
    script: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    return runProcess(SANDBOX_EXEC, ['-f', paths.profile, SHELL, '-dfc', script], {
      cwd,
      env: {
        HOME: paths.home,
        TMPDIR: paths.temp,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      signal,
    });
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
      resolvePromise({
        exitCode: code ?? (signal ? 128 : 1),
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
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

function resolveContainedPath(root: string, cwdRelative: string): string {
  const candidate = resolve(root, cwdRelative || '.');
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(prefix))
    throw new Error('working directory escapes the authorized folder');
  return candidate;
}

function seatbeltProfile(paths: ShellTaskPaths): string {
  const allowedReadRoots = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/Library/Apple',
    '/Library/Preferences',
    '/private/etc',
    '/private/var/db',
    '/Applications/Xcode.app',
    '/opt/homebrew',
    '/usr/local',
    paths.source,
    paths.taskRoot,
  ];
  const readRules = allowedReadRoots.map((path) => `(subpath ${schemeQuote(path)})`).join('\n    ');
  const executableRoots = [
    '/System',
    '/usr/lib',
    '/Library/Apple',
    '/Applications/Xcode.app',
    '/opt/homebrew',
    '/usr/local',
    paths.source,
    paths.workspace,
  ];
  const executableRules = executableRoots
    .map((path) => `(subpath ${schemeQuote(path)})`)
    .join('\n    ');
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon"))
(allow user-preference-read)
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow file-map-executable
  ${executableRules})
(allow file-read* file-test-existence
  ${readRules}
  (literal "/"))
(allow file-read-metadata
  (subpath "/var")
  (subpath "/private/var")
  (literal "/tmp")
  (literal "/etc"))
(allow file-read* file-test-existence
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (subpath "/dev/fd"))
(allow file-write*
  (subpath ${schemeQuote(paths.workspace)})
  (subpath ${schemeQuote(paths.home)})
  (subpath ${schemeQuote(paths.temp)})
  (literal "/dev/null")
  (subpath "/dev/fd"))
`;
}

function schemeQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
