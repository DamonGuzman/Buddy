/** Stateful reconciliation between macOS TCC status and the real uiohook. */

import { app } from 'electron';
import type {
  PermissionAction,
  PermissionActionResult,
  PermissionHealth,
} from '../../shared/types';
import type { HotkeyManager } from '../hotkey';
import {
  buildMacPermissionHealth,
  getMacPermissionSnapshot,
  repairMacPermission,
  resetMacPermissionGrants,
  revealCurrentBuddy,
} from './mac-permissions';
import type { MacPermissionRepairResult, MacPermissionSnapshot } from './mac-permissions';

type HotkeyControl = Pick<HotkeyManager, 'start' | 'stop' | 'status'>;

export interface PermissionControllerOptions {
  hotkey: HotkeyControl;
  readSnapshot?: () => MacPermissionSnapshot;
  buildHealth?: (
    snapshot: MacPermissionSnapshot,
    status: ReturnType<HotkeyControl['status']>,
  ) => PermissionHealth;
  repair?: (permission: PermissionAction & { type: 'open' }) => Promise<MacPermissionRepairResult>;
  reset?: () => MacPermissionRepairResult;
  reveal?: () => MacPermissionRepairResult;
  restart?: () => void;
  isMacOS?: () => boolean;
  onHealth?: (health: PermissionHealth) => void;
  onHookState?: (health: PermissionHealth) => void;
  onUnavailable?: (error: Error, health: PermissionHealth) => void;
  onRecovered?: (health: PermissionHealth) => void;
}

export class PermissionController {
  private readonly readSnapshot: () => MacPermissionSnapshot;
  private readonly buildHealth: NonNullable<PermissionControllerOptions['buildHealth']>;
  private readonly repair: NonNullable<PermissionControllerOptions['repair']>;
  private readonly reset: NonNullable<PermissionControllerOptions['reset']>;
  private readonly reveal: NonNullable<PermissionControllerOptions['reveal']>;
  private readonly restart: NonNullable<PermissionControllerOptions['restart']>;
  private lastHotkeyGrantFingerprint = '';
  private issueReported = false;

  constructor(private readonly options: PermissionControllerOptions) {
    this.readSnapshot = options.readSnapshot ?? (() => getMacPermissionSnapshot(false));
    this.buildHealth =
      options.buildHealth ?? ((snapshot, status) => buildMacPermissionHealth(snapshot, status));
    this.repair = options.repair ?? ((action) => repairMacPermission(action.permission));
    this.reset = options.reset ?? resetMacPermissionGrants;
    this.reveal = options.reveal ?? revealCurrentBuddy;
    this.restart =
      options.restart ??
      (() => {
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 250);
      });
  }

  current(): PermissionHealth {
    return this.buildHealth(this.readSnapshot(), this.options.hotkey.status());
  }

  /** Check grants, stop on revocation, and retry once on a valid transition. */
  refresh(forceHotkeyRetry = false): PermissionHealth {
    const snapshot = this.readSnapshot();
    const hotkeyGrantsReady =
      !(this.options.isMacOS?.() ?? process.platform === 'darwin') ||
      (snapshot.accessibility && snapshot.inputMonitoring === true);
    const fingerprint = `${snapshot.accessibility}:${String(snapshot.inputMonitoring)}`;

    if (!hotkeyGrantsReady) {
      this.lastHotkeyGrantFingerprint = fingerprint;
      if (this.options.hotkey.status().hookAlive) this.options.hotkey.stop();
    } else if (
      !this.options.hotkey.status().hookAlive &&
      (forceHotkeyRetry || fingerprint !== this.lastHotkeyGrantFingerprint)
    ) {
      this.lastHotkeyGrantFingerprint = fingerprint;
      this.options.hotkey.start();
    }

    const health = this.buildHealth(snapshot, this.options.hotkey.status());
    this.publish(health);
    return health;
  }

  /** HotkeyManager emits synchronously when a native start/retry fails. */
  noteHotkeyError(error: Error): PermissionHealth {
    const health = this.current();
    if (!this.issueReported) {
      this.issueReported = true;
      this.options.onUnavailable?.(error, health);
    }
    this.options.onHookState?.(health);
    this.options.onHealth?.(health);
    return health;
  }

  async act(action: PermissionAction): Promise<PermissionActionResult> {
    if (action.type === 'open') {
      const result = await this.repair(action);
      return this.result(result.ok, result.message);
    }
    if (action.type === 'recheck') {
      const health = this.refresh();
      if (health.nextPermission === null && health.hotkeyAlive) {
        return { ok: true, message: 'Everything Buddy needs is working.', health };
      }
      if (health.restartRecommended) {
        return {
          ok: false,
          message:
            'The toggles look allowed, but this Buddy process still cannot grab the hotkey. ' +
            'Try the live retry, then restart if it stays offline.',
          health,
        };
      }
      return {
        ok: false,
        message: 'Buddy is still waiting for the permissions marked below.',
        health,
      };
    }
    if (action.type === 'retry-hotkey') {
      const health = this.refresh(true);
      return {
        ok: health.hotkeyAlive,
        message: health.hotkeyAlive
          ? 'Push-to-talk is live again — no restart needed.'
          : 'The hotkey is still blocked. Restart Buddy; if it remains blocked, use reset stale grants for a guided clean start.',
        health,
      };
    }
    if (action.type === 'reset-grants') {
      const result = this.reset();
      return this.result(result.ok, result.message);
    }
    if (action.type === 'reveal-app') {
      const result = this.reveal();
      return this.result(result.ok, result.message);
    }

    const health = this.current();
    this.restart();
    return { ok: true, message: 'Restarting Buddy now…', health };
  }

  private result(ok: boolean, message: string): PermissionActionResult {
    return { ok, message, health: this.refresh() };
  }

  private publish(health: PermissionHealth): void {
    this.options.onHookState?.(health);
    this.options.onHealth?.(health);
    if (health.hotkeyAlive) {
      this.issueReported = false;
      this.options.onRecovered?.(health);
    } else if (!this.issueReported) {
      this.issueReported = true;
      const detail = health.hotkeyError ?? 'required hotkey permissions are not granted';
      this.options.onUnavailable?.(new Error(detail), health);
    }
  }
}
