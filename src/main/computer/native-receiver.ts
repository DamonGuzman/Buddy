import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import {
  queryMacFocusedReceiverRaw,
  restoreMacFocusedReceiver,
} from '../windows/mac-screen-permission';

/** Includes cold PowerShell + UIAutomation assembly startup on supported Windows hosts. */
const RECEIVER_TIMEOUT_MS = 2_000;

export interface NativeReceiverProvider {
  query(): Promise<string | null>;
  restore(identity: string): Promise<boolean>;
}

interface RectIdentity {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReceiverIdentity {
  platform: 'darwin' | 'win32';
  pid: number;
  window: { handle: string; identifier: string; title: string; rect: RectIdentity };
  focus: {
    pid: number;
    role: string;
    identifier: string;
    nativeHandle: string;
    runtimeId: number[];
    rect: RectIdentity;
  };
}

type ExecReceiver = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

export interface NativeReceiverProviderOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  queryMac?: () => string | null;
  restoreMac?: (token: string) => boolean;
  exec?: ExecReceiver;
}

interface RetainedObservation {
  identity: ReceiverIdentity;
  macToken: string | null;
}

export class PlatformNativeReceiverProvider implements NativeReceiverProvider {
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly queryMac: () => string | null;
  private readonly restoreMac: (token: string) => boolean;
  private readonly exec: ExecReceiver;
  private readonly observations = new Map<string, RetainedObservation>();

  constructor(options: NativeReceiverProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? RECEIVER_TIMEOUT_MS;
    this.queryMac = options.queryMac ?? queryMacFocusedReceiverRaw;
    this.restoreMac = options.restoreMac ?? restoreMacFocusedReceiver;
    this.exec = options.exec ?? execFile;
  }

  async query(): Promise<string | null> {
    const raw =
      this.platform === 'darwin'
        ? this.queryMac()
        : this.platform === 'win32'
          ? await this.execScript(WINDOWS_RECEIVER_SCRIPT)
          : null;
    const identity =
      this.platform === 'darwin'
        ? parseMacReceiver(raw)
        : this.platform === 'win32'
          ? parseWindowsReceiver(raw)
          : null;
    if (identity === null) return null;
    const macToken = this.platform === 'darwin' ? parseMacRestoreToken(raw) : null;
    if (this.platform === 'darwin' && macToken === null) return null;
    const canonical = canonicalReceiver(identity);
    this.remember(canonical, {
      identity,
      macToken,
    });
    return canonical;
  }

  async restore(identity: string): Promise<boolean> {
    const retained = this.observations.get(identity);
    if (!retained || retained.identity.platform !== this.platform) return false;
    let restored = false;
    if (this.platform === 'darwin') {
      restored = retained.macToken !== null && this.restoreMac(retained.macToken);
    } else if (this.platform === 'win32') {
      const expected = Buffer.from(JSON.stringify(retained.identity), 'utf8').toString('base64');
      const raw = await this.execScript(WINDOWS_RESTORE_SCRIPT.replace('__EXPECTED__', expected));
      restored = record(parseJson(raw))?.['ok'] === true;
    }
    if (restored) await delay(75);
    return restored;
  }

  private remember(identity: string, observation: RetainedObservation): void {
    this.observations.delete(identity);
    this.observations.set(identity, observation);
    while (this.observations.size > 32) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
  }

  private execScript(script: string): Promise<string | null> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      this.exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded],
        { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => resolve(error ? null : stdout.trim().slice(0, 64 * 1024)),
      );
    });
  }
}

export function parseMacReceiver(raw: unknown): ReceiverIdentity | null {
  const source = parseRecord(raw);
  if (!source) return null;
  const pid = positiveInteger(source['pid']);
  const window = record(source['window']);
  const focus = record(source['focus']);
  const windowRect = rect(window);
  const focusRect = rect(focus);
  const role = boundedString(focus?.['role'], 160);
  if (!pid || !window || !focus || !windowRect || !focusRect || !role) return null;
  return {
    platform: 'darwin',
    pid,
    window: {
      handle: '',
      identifier: boundedString(window['identifier'], 500) ?? '',
      title: boundedString(window['title'], 500) ?? '',
      rect: windowRect,
    },
    focus: {
      pid,
      role,
      identifier: boundedString(focus['identifier'], 500) ?? '',
      nativeHandle: '',
      runtimeId: [],
      rect: focusRect,
    },
  };
}

export function parseWindowsReceiver(raw: unknown): ReceiverIdentity | null {
  const source = parseRecord(raw);
  if (!source) return null;
  const pid = positiveInteger(source['pid']);
  const focusPid = positiveInteger(source['focusPid']);
  const windowRect = rect(record(source['windowRect']));
  const focusRect = rect(record(source['focusRect']));
  const handle = boundedString(source['windowHandle'], 64);
  const role = boundedString(source['controlType'], 160);
  const runtimeId = integerArray(source['runtimeId'], 32);
  if (!pid || !focusPid || !windowRect || !focusRect || !handle || !role || !runtimeId)
    return null;
  return {
    platform: 'win32',
    pid,
    window: {
      handle,
      identifier: '',
      title: boundedString(source['windowTitle'], 500) ?? '',
      rect: windowRect,
    },
    focus: {
      pid: focusPid,
      role,
      identifier: boundedString(source['automationId'], 500) ?? '',
      nativeHandle: boundedString(source['focusHandle'], 64) ?? '',
      runtimeId,
      rect: focusRect,
    },
  };
}

function canonicalReceiver(identity: ReceiverIdentity): string {
  return JSON.stringify(identity);
}

function parseRecord(raw: unknown): Record<string, unknown> | null {
  return record(parseJson(raw));
}

function parseJson(raw: unknown): unknown {
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  } catch {
    return null;
  }
}

function parseMacRestoreToken(raw: unknown): string | null {
  return boundedString(parseRecord(raw)?.['restoreToken'], 128);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rect(value: Record<string, unknown> | null): RectIdentity | null {
  if (!value) return null;
  const x = value['x'];
  const y = value['y'];
  const w = value['w'];
  const h = value['h'];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return null;
  }
  if (w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

function integerArray(value: unknown, max: number): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > max ||
    !value.every((item) => typeof item === 'number' && Number.isSafeInteger(item))
  ) {
    return null;
  }
  return [...value] as number[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WINDOWS_RECEIVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BuddyReceiverWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
"@
$hwnd = [BuddyReceiverWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { throw 'foreground window unavailable' }
[uint32]$pid = 0
[void][BuddyReceiverWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$wr = New-Object BuddyReceiverWin32+RECT
if (-not [BuddyReceiverWin32]::GetWindowRect($hwnd, [ref]$wr)) { throw 'window rect unavailable' }
$title = New-Object System.Text.StringBuilder 512
[void][BuddyReceiverWin32]::GetWindowText($hwnd, $title, $title.Capacity)
$focus = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focus) { throw 'focused element unavailable' }
$r = $focus.Current.BoundingRectangle
if ($r.Width -le 0 -or $r.Height -le 0) { throw 'focused rect unavailable' }
@{
  pid = [int]$pid
  windowHandle = $hwnd.ToInt64().ToString()
  windowTitle = $title.ToString()
  windowRect = @{ x=$wr.Left; y=$wr.Top; w=$wr.Right-$wr.Left; h=$wr.Bottom-$wr.Top }
  focusPid = $focus.Current.ProcessId
  focusHandle = $focus.Current.NativeWindowHandle.ToString()
  automationId = $focus.Current.AutomationId
  controlType = $focus.Current.ControlType.ProgrammaticName
  runtimeId = @($focus.GetRuntimeId())
  focusRect = @{ x=$r.X; y=$r.Y; w=$r.Width; h=$r.Height }
} | ConvertTo-Json -Compress -Depth 4
`;

const WINDOWS_RESTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BuddyReceiverRestoreWin32 {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
"@
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXPECTED__'))
$expected = $json | ConvertFrom-Json
$hwnd = [IntPtr][Convert]::ToInt64($expected.window.handle)
if ($hwnd -eq [IntPtr]::Zero -or -not [BuddyReceiverRestoreWin32]::IsWindow($hwnd)) {
  throw 'retained window is unavailable'
}
[uint32]$pid = 0
[void][BuddyReceiverRestoreWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
if ([int]$pid -ne [int]$expected.pid) { throw 'retained window owner changed' }
if (-not [BuddyReceiverRestoreWin32]::SetForegroundWindow($hwnd)) {
  throw 'foreground window restoration was rejected'
}
function Test-RuntimeId($candidate, $expectedId) {
  try {
    $actual = @($candidate.GetRuntimeId())
    if ($actual.Count -ne $expectedId.Count) { return $false }
    for ($i = 0; $i -lt $actual.Count; $i++) {
      if ([int]$actual[$i] -ne [int]$expectedId[$i]) { return $false }
    }
    return $true
  } catch { return $false }
}
$target = $null
$focusHandle = [IntPtr][Convert]::ToInt64($expected.focus.nativeHandle)
if ($focusHandle -ne [IntPtr]::Zero -and [BuddyReceiverRestoreWin32]::IsWindow($focusHandle)) {
  $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($focusHandle)
  if (Test-RuntimeId $candidate @($expected.focus.runtimeId)) { $target = $candidate }
}
if ($null -eq $target) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $items = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Subtree,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($candidate in $items) {
    if (Test-RuntimeId $candidate @($expected.focus.runtimeId)) {
      $target = $candidate
      break
    }
  }
}
if ($null -eq $target) { throw 'retained focused element is unavailable' }
if ([int]$target.Current.ProcessId -ne [int]$expected.focus.pid) {
  throw 'retained focused element owner changed'
}
$target.SetFocus()
@{ ok = $true } | ConvertTo-Json -Compress
`;
