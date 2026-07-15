import type { ElementFacts } from '../agents/gate/trigger';
import type { CaptureResult } from '../capture';
import type { MouseButton } from './input-controller';

export type { MouseButton } from './input-controller';

/** A point expressed in pixels of the capture selected by `screenIndex`. */
export interface DriverPoint {
  screenIndex: number;
  x: number;
  y: number;
}

/** A form value read only for action review; credential fields are redacted before leaving main. */
export interface DriverPayloadField {
  name: string;
  value: string;
  type?: string;
}

/**
 * The actuation surface consumed by computer-use loops.
 *
 * Coordinates never escape the selected screenshot's pixel space at this
 * boundary. Each driver is responsible for mapping them to its native input
 * coordinate system.
 */
export interface ComputerDriver {
  /** Return a fresh observation of this driver's surface. */
  capture(): Promise<CaptureResult[]>;
  click(target: DriverPoint, button: MouseButton, count: 1 | 2): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  navigate?(url: string): Promise<void>;
  scroll?(target: DriverPoint, dy: number): Promise<void>;
  /** Inspect the element that would receive typing or keyboard input. */
  inspectFocused(): Promise<ElementFacts | null>;
  inspect(target: DriverPoint): Promise<ElementFacts | null>;
  /** Read the pending form payload at a point, or at the focused element when target is null. */
  readPendingPayload(target: DriverPoint | null): Promise<DriverPayloadField[]>;
  dispose(): Promise<void>;
}
