import { screen } from 'electron';
import { captureAllDisplays } from '../capture';
import type { CaptureResult } from '../capture';
import { mapModelPoint } from '../coords';
import type { Point } from '../coords';
import type { ComputerDriver, DriverPoint, MouseButton } from './driver';
import type { ComputerInputController } from './input-controller';

export interface LiveDesktopDriverOptions {
  input: ComputerInputController;
  /** Existing turn captures avoid a redundant capture before the first action. */
  initialCaptures?: CaptureResult[];
  capture?: () => Promise<CaptureResult[]>;
  /** DIP -> physical px conversion (tests inject; default Electron `screen`). */
  dipToScreenPoint?: (point: Point) => Point;
}

/** Drives the user's live desktop while keeping native coordinate details local. */
export class LiveDesktopDriver implements ComputerDriver {
  private captures: CaptureResult[];
  private readonly captureDesktop: () => Promise<CaptureResult[]>;
  private readonly dipToScreenPoint: (point: Point) => Point;

  constructor(private readonly options: LiveDesktopDriverOptions) {
    this.captures = options.initialCaptures ? [...options.initialCaptures] : [];
    this.captureDesktop = options.capture ?? captureAllDisplays;
    this.dipToScreenPoint = options.dipToScreenPoint ?? inputPointFromDip;
  }

  async capture(): Promise<CaptureResult[]> {
    const captures = await this.captureDesktop();
    this.captures = [...captures];
    return captures;
  }

  async click(target: DriverPoint, button: MouseButton, count: 1 | 2): Promise<void> {
    const capture = this.captures.find((item) => item.meta.screenIndex === target.screenIndex);
    if (!capture) throw new Error('that screenshot does not exist');
    const mapped = mapModelPoint({ x: target.x, y: target.y }, capture.meta);
    const physical = this.dipToScreenPoint(mapped.global);
    await this.options.input.click(physical.x, physical.y, button, count);
  }

  async typeText(text: string): Promise<void> {
    await this.options.input.typeText(text);
  }

  async pressKeys(keys: string[]): Promise<void> {
    await this.options.input.pressKeys(keys);
  }

  async navigate(_url: string): Promise<void> {
    throw new Error('navigate is unsupported by the live desktop driver');
  }

  async scroll(_target: DriverPoint, _dy: number): Promise<void> {
    throw new Error('scroll is unsupported by the live desktop driver');
  }

  async inspect(_target: DriverPoint): Promise<null> {
    return null;
  }

  async inspectFocused(): Promise<null> {
    return null;
  }

  async readPendingPayload(_target: DriverPoint | null): Promise<[]> {
    return [];
  }

  async dispose(): Promise<void> {
    this.options.input.dispose();
  }
}

/** CoreGraphics mouse coordinates are macOS global logical points, matching Electron DIPs. */
export function inputPointFromDip(
  point: Point,
  platform: NodeJS.Platform = process.platform,
): Point {
  return platform === 'darwin'
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : screen.dipToScreenPoint(point);
}
