/**
 * Opt-in native Windows UIA verification. This is deliberately excluded from
 * ordinary cross-platform tests: it creates two real WPF windows and drives
 * the production PowerShell daemon. Run with BUDDY_WINDOWS_UIA_E2E=1.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GroundingService } from '../src/main/grounding/snapper';

interface FixtureReady {
  fixturePid: number;
  query: { x: number; y: number };
  target: { x: number; y: number };
}

const enabled = process.platform === 'win32' && process.env['BUDDY_WINDOWS_UIA_E2E'] === '1';

describe.runIf(enabled)('Windows UIA native end-to-end', () => {
  let fixture: ChildProcessWithoutNullStreams;
  let ready: FixtureReady;
  let service: GroundingService;
  let scriptDir: string;

  beforeAll(async () => {
    fixture = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('tools/windows-uia-fixture.ps1'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false },
    );
    ready = await firstJsonLine(fixture, 15_000);
    scriptDir = mkdtempSync(join(tmpdir(), 'buddy-uia-e2e-'));
    service = new GroundingService({ scriptDir, excludePid: process.pid, timeboxMs: 8_000 });
    service.warmUp();
  }, 20_000);

  afterAll(() => {
    service?.dispose();
    if (fixture && fixture.exitCode === null) fixture.kill();
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
  });

  it('finds a named control in the adjacent visible app window', async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await service.snap(
        {
          x: ready.query.x,
          y: ready.query.y,
          label: 'the Buddy Adjacent Target button',
          radiusPx: 900,
        },
        { debug: true, timeboxMs: 8_000 },
      );

      console.info('native Windows UIA outcome', JSON.stringify({ attempt, ready, outcome }));

      expect(outcome.matched).toBe(true);
      expect(outcome.name).toBe('Buddy Adjacent Target');
      expect(outcome.point).not.toBeNull();
      expect(Math.abs((outcome.point?.x ?? 0) - ready.target.x)).toBeLessThanOrEqual(4);
      expect(Math.abs((outcome.point?.y ?? 0) - ready.target.y)).toBeLessThanOrEqual(4);
      const target = outcome.debug?.find(
        (candidate) => candidate.name === 'Buddy Adjacent Target',
      );
      expect(target?.windowRank).toBeGreaterThan(0);
      expect(outcome.timedOut).toBe(false);
    }
  }, 30_000);
});

function firstJsonLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<FixtureReady> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Windows UIA fixture did not become ready: ${stderr || 'timed out'}`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as FixtureReady;
        cleanup();
        resolveReady(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Windows UIA fixture exited before ready (code ${code}): ${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}
