import { MacInputController } from './mac-input';
import { WindowsInputController } from './windows-input';

export type MouseButton = 'left' | 'right' | 'middle';

/** Global OS input operations used by the computer-use operator. */
export interface ComputerInputController {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button?: MouseButton, count?: number): Promise<void>;
  /** Positive Y scrolls up; positive X scrolls right. */
  scroll(deltaX: number, deltaY: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  dispose(): void;
}

export function createComputerInputController(
  scriptDir: string,
  platform: NodeJS.Platform = process.platform,
): ComputerInputController {
  if (platform === 'win32') return new WindowsInputController(scriptDir);
  if (platform === 'darwin') return new MacInputController();
  throw new Error(`computer use is not available on ${platform}`);
}
