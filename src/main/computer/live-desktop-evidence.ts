import { nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import type { CaptureResult } from '../capture';
import type { DriverPoint } from './driver';
import { PlatformNativeReceiverProvider, type NativeReceiverProvider } from './native-receiver';

export interface LiveDesktopEvidencePort {
  /** Null means keyboard receiver identity cannot be established safely. */
  receiverIdentity?(): Promise<string | null>;
  /** Restore only an identity previously returned by this evidence instance. */
  restoreReceiverIdentity?(identity: string): Promise<boolean>;
  /** Stable identity for the action receiver in this fresh observation. */
  fingerprint(
    captures: readonly CaptureResult[],
    anchor: DriverPoint | null,
    requiresReceiverIdentity: boolean,
    receiverIdentity?: string | null,
  ): Promise<string | null>;
}

/**
 * Conservative visual fallback for a surface without DOM/accessibility facts.
 * Point actions and a field selected by the immediately preceding click use a
 * dense quantized local crop, so clocks, video, and unrelated monitors cannot
 * stale an approval. Keyboard-only actions fall back to the active display.
 */
export class VisualLiveDesktopEvidence implements LiveDesktopEvidencePort {
  async receiverIdentity(): Promise<string | null> {
    return null;
  }

  async restoreReceiverIdentity(_identity: string): Promise<boolean> {
    return false;
  }

  async fingerprint(
    captures: readonly CaptureResult[],
    anchor: DriverPoint | null,
    requiresReceiverIdentity: boolean,
  ): Promise<string | null> {
    // Pixels cannot prove native keyboard focus. Production must inject an
    // AX/UIA receiver evidence port before type/press_keys can execute.
    if (requiresReceiverIdentity) return null;
    const capture =
      (anchor
        ? captures.find((item) => item.meta.screenIndex === anchor.screenIndex)
        : captures.find((item) => item.meta.isActive)) ?? captures[0];
    if (!capture) return digest('live-desktop-unobserved');
    const identity = `${capture.meta.displayId}:${capture.meta.imageW}x${capture.meta.imageH}`;
    if (!nativeImage) return digest(`${identity}:${capture.jpegBase64}`);
    const image = nativeImage.createFromBuffer(Buffer.from(capture.jpegBase64, 'base64'));
    if (image.isEmpty()) return digest(`${identity}:${capture.jpegBase64}`);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    if (bitmap.length < size.width * size.height * 4)
      return digest(`${identity}:${capture.jpegBase64}`);
    return `${identity}:${coarseVisualFingerprint(
      bitmap,
      size.width,
      size.height,
      anchor ? { x: anchor.x, y: anchor.y } : null,
    )}`;
  }
}

/** Production evidence: native receiver identity plus bounded visual state. */
export class NativeReceiverLiveDesktopEvidence extends VisualLiveDesktopEvidence {
  constructor(
    private readonly receiver: NativeReceiverProvider = new PlatformNativeReceiverProvider(),
  ) {
    super();
  }

  override receiverIdentity(): Promise<string | null> {
    return this.receiver.query();
  }

  override restoreReceiverIdentity(identity: string): Promise<boolean> {
    return this.receiver.restore(identity);
  }

  override async fingerprint(
    captures: readonly CaptureResult[],
    anchor: DriverPoint | null,
    requiresReceiverIdentity: boolean,
    observedReceiverIdentity?: string | null,
  ): Promise<string | null> {
    const visual = await super.fingerprint(captures, anchor, false);
    if (!requiresReceiverIdentity) return visual;
    const receiver = observedReceiverIdentity ?? (await this.receiverIdentity());
    return receiver === null || visual === null ? null : `${receiver}\0${visual}`;
  }
}

export function coarseVisualFingerprint(
  bitmap: Buffer,
  width: number,
  height: number,
  anchor: { x: number; y: number } | null,
): string {
  if (width < 1 || height < 1 || bitmap.length < width * height * 4) {
    throw new Error('live desktop evidence bitmap is invalid');
  }
  const diameter = Math.max(32, Math.min(128, Math.round(Math.min(width, height) / 8)));
  const region = anchor
    ? {
        x: clamp(Math.round(anchor.x - diameter / 2), 0, Math.max(0, width - diameter)),
        y: clamp(Math.round(anchor.y - diameter / 2), 0, Math.max(0, height - diameter)),
        width: Math.min(diameter, width),
        height: Math.min(diameter, height),
      }
    : { x: 0, y: 0, width, height };
  const hash = createHash('sha256');
  hash.update(`${region.width}x${region.height}\0`);
  const row = Buffer.allocUnsafe(region.width * 3);
  for (let y = region.y; y < region.y + region.height; y += 1) {
    let output = 0;
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * width + x) * 4;
      // Preserve every pixel position and channel, while discarding the three
      // lowest bits to tolerate bounded JPEG/antialias noise. Unlike block
      // averages, rearranged text/control pixels cannot retain the same
      // fingerprint unless the full quantized crop has a SHA-256 collision.
      row[output++] = (bitmap[offset] ?? 0) >>> 3;
      row[output++] = (bitmap[offset + 1] ?? 0) >>> 3;
      row[output++] = (bitmap[offset + 2] ?? 0) >>> 3;
    }
    hash.update(row);
  }
  return hash.digest('hex');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
