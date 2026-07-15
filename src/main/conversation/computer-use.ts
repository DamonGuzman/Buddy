/**
 * The `use_computer` delegation tool: the realtime voice model (and the M18
 * text model) never get direct mouse/keyboard access — a task string is
 * handed to a separate gpt-5.6-sol Responses loop over the user's ChatGPT
 * subscription (ComputerUseOperator), which inspects a fresh screenshot
 * after every single action. This runner owns the availability gate, the
 * one-at-a-time busy latch, and the shared Windows input controller.
 */

import { resolveGroundingAuth } from '../auth/auth-source';
import type { CodexProvider } from '../auth/auth-source';
import type { CaptureResult } from '../capture';
import { ComputerUseOperator } from '../computer/operator';
import { createComputerInputController } from '../computer/input-controller';
import type { ComputerInputController } from '../computer/input-controller';
import { supportsComputerUse } from '../platform';
import { asRecord, asString, errorMessage } from '../util/guards';
import type { SettingsPort } from './ports';
import type { TurnGuard } from './turn-guard';

export interface ComputerUseDeps {
  settings: SettingsPort;
  guard: TurnGuard;
  codexProvider: () => CodexProvider;
  /**
   * The persona/tool snapshot the session was built with — the live settings
   * flag is re-checked per action via `isAllowed` below.
   */
  enabledSnapshot: () => boolean;
  /** M17: fail-closed plan-limit copy, once per episode. */
  surfacePlanLimitOnce: (token: number) => void;
  /** Directory the input controller materializes its script into (userData). */
  userDataDir: () => string;
}

export class ComputerUseRunner {
  private input: ComputerInputController | null = null;
  private busy = false;

  constructor(private readonly deps: ComputerUseDeps) {}

  /** Sol needs a supported desktop platform + settings opt-in + ChatGPT sign-in. */
  available(): boolean {
    if (!this.deps.enabledSnapshot() || !supportsComputerUse()) return false;
    try {
      return this.deps.codexProvider().getCodexAuth() !== null;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.input?.dispose();
  }

  async run(value: unknown, captures: CaptureResult[], token: number): Promise<object> {
    const { deps } = this;
    const args = asRecord(value) ?? {};
    const task = asString(args['task']).trim().slice(0, 2_000);
    if (!task) return { error: 'task is required' };
    if (!deps.enabledSnapshot()) return { error: 'computer use is turned off in settings' };
    if (this.busy) return { error: 'sol is already operating the computer' };
    const resolved = resolveGroundingAuth({
      getApiKey: () => null,
      codex: deps.codexProvider(),
    });
    if (resolved === null || resolved.kind !== 'chatgptCodex') {
      return { error: 'computer use needs chatgpt sign-in' };
    }
    this.input ??= createComputerInputController(deps.userDataDir());
    this.busy = true;
    try {
      const operator = new ComputerUseOperator({
        auth: resolved,
        input: this.input,
        initialCaptures: [...captures],
        isAllowed: () => !deps.guard.isStale(token) && deps.settings.get().computerUseEnabled,
      });
      const result = await operator.run(task);
      if (result.quotaExhausted) deps.surfacePlanLimitOnce(token);
      return result.ok
        ? {
            ok: true,
            summary: result.summary,
            actions: result.actions,
            model: 'gpt-5.6-sol',
            fast_mode: true,
          }
        : { error: result.summary, actions: result.actions, model: 'gpt-5.6-sol', fast_mode: true };
    } catch (error) {
      return { error: errorMessage(error) };
    } finally {
      this.busy = false;
    }
  }
}
