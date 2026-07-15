import { systemPreferences } from 'electron';
import type { ComputerInputController, MouseButton } from './input-controller';
import { postMacInput, type MacInputRequest } from '../windows/mac-screen-permission';

export interface MacInputControllerOptions {
  platform?: NodeJS.Platform;
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
  postInput?: (request: MacInputRequest) => void;
}

/** Global input posted synchronously by Buddy's signed macOS process. */
export class MacInputController implements ComputerInputController {
  private readonly platform: NodeJS.Platform;
  private readonly isTrusted: (prompt: boolean) => boolean;
  private readonly postInput: (request: MacInputRequest) => void;
  private disposed = false;

  constructor(options: MacInputControllerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.isTrusted =
      options.isTrustedAccessibilityClient ??
      ((prompt) => systemPreferences.isTrustedAccessibilityClient(prompt));
    this.postInput = options.postInput ?? postMacInput;
  }

  move(x: number, y: number): Promise<void> {
    requireCoordinate(x, 'x');
    requireCoordinate(y, 'y');
    return this.request({ action: 'move', x: Math.round(x), y: Math.round(y) });
  }

  click(x: number, y: number, button: MouseButton = 'left', count = 1): Promise<void> {
    requireCoordinate(x, 'x');
    requireCoordinate(y, 'y');
    if (count !== 1 && count !== 2) throw new Error('click count must be one or two');
    return this.request({
      action: 'click',
      x: Math.round(x),
      y: Math.round(y),
      button,
      count,
    });
  }

  scroll(deltaX: number, deltaY: number): Promise<void> {
    requireCoordinate(deltaX, 'deltaX');
    requireCoordinate(deltaY, 'deltaY');
    return this.request({
      action: 'scroll',
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  }

  typeText(text: string): Promise<void> {
    if (typeof text !== 'string' || text.length < 1 || text.length > 10_000) {
      throw new Error('text must contain one to 10000 characters');
    }
    return this.request({ action: 'type_text', text });
  }

  pressKeys(keys: string[]): Promise<void> {
    if (
      !Array.isArray(keys) ||
      keys.length < 1 ||
      keys.length > 8 ||
      !keys.every((key) => typeof key === 'string' && key.trim().length > 0)
    ) {
      throw new Error('keys must be an array of one to eight non-empty strings');
    }
    return this.request({ action: 'press_keys', keys });
  }

  dispose(): void {
    this.disposed = true;
  }

  private request(payload: MacInputRequest): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('input controller stopped'));
    if (this.platform !== 'darwin') {
      return Promise.reject(new Error('macOS input is only available on macOS'));
    }
    if (!this.isTrusted(true)) {
      return Promise.reject(
        new Error(
          'macOS Accessibility permission is required; enable Buddy in System Settings > Privacy & Security > Accessibility',
        ),
      );
    }
    try {
      this.postInput(payload);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function requireCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}
