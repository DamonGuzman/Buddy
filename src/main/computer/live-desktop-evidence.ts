import { nativeImage, screen } from 'electron';
import { createHash } from 'node:crypto';
import type { CaptureResult } from '../capture';
import type { DriverPoint } from './driver';
import {
  parseReceiverFocusGeometry,
  PlatformNativeReceiverProvider,
  type NativeReceiverProvider,
  type ReceiverFocusGeometry,
} from './native-receiver';

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_VISUAL_SAMPLE_PIXELS = 512 * 512;
const MAX_VISUAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;

type NativePointToDip = (
  platform: ReceiverFocusGeometry['platform'],
  point: { x: number; y: number },
) => { x: number; y: number };

export interface LiveDesktopEvidencePort {
  /** Null means keyboard receiver identity cannot be established safely. */
  receiverIdentity?(): Promise<string | null>;
  /** Restore only an identity previously returned by this evidence instance. */
  restoreReceiverIdentity?(identity: string): Promise<boolean>;
  /**
   * Arm a one-use, native receiver-bound proof before literal text dispatch.
   * The opaque token must not contain the control's current value, selection,
   * or a reversible representation of either.
   */
  prepareTypeTextPostcondition?(identity: string, text: string): Promise<string | null>;
  /**
   * Prove that the exact retained receiver now contains the intended edit.
   * False means the action is mechanically unconfirmed and must fail closed.
   */
  verifyTypeTextPostcondition?(proofToken: string): Promise<boolean>;
  /** Exact capture containing the receiver, or null when mapping is ambiguous. */
  receiverCaptureScreenIndex?(captures: readonly CaptureResult[], identity: string): number | null;
  /** Stable identity for the action receiver in this fresh observation. */
  fingerprint(
    captures: readonly CaptureResult[],
    anchor: DriverPoint | null,
    requiresReceiverIdentity: boolean,
    receiverIdentity?: string | null,
    requiresReceiverVisualEvidence?: boolean,
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

  async prepareTypeTextPostcondition(_identity: string, _text: string): Promise<string | null> {
    return null;
  }

  async verifyTypeTextPostcondition(_proofToken: string): Promise<boolean> {
    return false;
  }

  receiverCaptureScreenIndex(
    _captures: readonly CaptureResult[],
    _identity: string,
  ): number | null {
    return null;
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
  private readonly visualSnapshots = new Map<
    string,
    { captureKey: string; pixels: Buffer; sampleRegion: PixelRegion; fingerprint: string }
  >();

  constructor(
    private readonly receiver: NativeReceiverProvider = new PlatformNativeReceiverProvider(),
    private readonly nativePointToDip: NativePointToDip = defaultNativePointToDip,
  ) {
    super();
  }

  override receiverIdentity(): Promise<string | null> {
    return this.receiver.query();
  }

  override restoreReceiverIdentity(identity: string): Promise<boolean> {
    return this.receiver.restore(identity);
  }

  override prepareTypeTextPostcondition(identity: string, text: string): Promise<string | null> {
    return this.receiver.prepareTypeTextPostcondition(identity, text);
  }

  override verifyTypeTextPostcondition(proofToken: string): Promise<boolean> {
    return this.receiver.verifyTypeTextPostcondition(proofToken);
  }

  override receiverCaptureScreenIndex(
    captures: readonly CaptureResult[],
    identity: string,
  ): number | null {
    const geometry = parseReceiverFocusGeometry(identity);
    if (geometry === null) return null;
    return (
      mapReceiverFocusToCapture(captures, geometry, this.nativePointToDip)?.capture.meta
        .screenIndex ?? null
    );
  }

  override async fingerprint(
    captures: readonly CaptureResult[],
    anchor: DriverPoint | null,
    requiresReceiverIdentity: boolean,
    observedReceiverIdentity?: string | null,
    requiresReceiverVisualEvidence = true,
  ): Promise<string | null> {
    if (!requiresReceiverIdentity) return super.fingerprint(captures, anchor, false);
    const receiver = observedReceiverIdentity ?? (await this.receiverIdentity());
    if (receiver === null) return null;
    // Literal text is mechanically bound to the exact retained native field.
    // JPEG pixels inside that field (notably the OS caret) are presentation,
    // not receiver identity. The approval still uses the receiver display.
    if (!requiresReceiverVisualEvidence) return receiver;
    const geometry = parseReceiverFocusGeometry(receiver);
    if (geometry === null) return null;
    const mapped = mapReceiverFocusToCapture(captures, geometry, this.nativePointToDip);
    if (mapped === null) return null;
    const snapshot = captureRegionSnapshot(mapped.capture, mapped.region);
    if (snapshot === null) return null;
    const previous = this.visualSnapshots.get(receiver);
    let visual = snapshot.fingerprint;
    if (
      previous &&
      previous.captureKey === snapshot.captureKey &&
      isBoundedTransientChange(previous.pixels, snapshot.pixels, snapshot.sampleRegion)
    ) {
      visual = previous.fingerprint;
    } else {
      this.visualSnapshots.delete(receiver);
      this.visualSnapshots.set(receiver, snapshot);
      enforceVisualSnapshotBudget(this.visualSnapshots);
    }
    return `${receiver}\0${visual}`;
  }
}

/** Map an exact native focused-control rectangle onto one captured display. */
export function mapReceiverFocusToCapture(
  captures: readonly CaptureResult[],
  geometry: ReceiverFocusGeometry,
  nativePointToDip: NativePointToDip = (_platform, point) => point,
): { capture: CaptureResult; region: PixelRegion } | null {
  const topLeft = nativePointToDip(geometry.platform, {
    x: geometry.rect.x,
    y: geometry.rect.y,
  });
  const bottomRight = nativePointToDip(geometry.platform, {
    x: geometry.rect.x + geometry.rect.w,
    y: geometry.rect.y + geometry.rect.h,
  });
  if (
    ![topLeft.x, topLeft.y, bottomRight.x, bottomRight.y].every(Number.isFinite) ||
    bottomRight.x <= topLeft.x ||
    bottomRight.y <= topLeft.y
  ) {
    return null;
  }
  const center = {
    x: (topLeft.x + bottomRight.x) / 2,
    y: (topLeft.y + bottomRight.y) / 2,
  };
  const matches = captures.filter(({ meta }) => {
    const bounds = meta.displayBounds;
    return (
      center.x >= bounds.x &&
      center.x < bounds.x + bounds.width &&
      center.y >= bounds.y &&
      center.y < bounds.y + bounds.height
    );
  });
  if (matches.length !== 1) return null;
  const capture = matches[0];
  if (!capture) return null;
  const { meta } = capture;
  const bounds = meta.displayBounds;
  // A focused control spanning outside its matched capture cannot be proven
  // from local pixels; do not silently clamp it to a different visual target.
  const epsilon = 1 / Math.max(1, meta.scaleFactor);
  if (
    topLeft.x < bounds.x - epsilon ||
    topLeft.y < bounds.y - epsilon ||
    bottomRight.x > bounds.x + bounds.width + epsilon ||
    bottomRight.y > bounds.y + bounds.height + epsilon
  ) {
    return null;
  }
  const x = clamp(
    Math.floor(((topLeft.x - bounds.x) * meta.imageW) / bounds.width),
    0,
    meta.imageW,
  );
  const y = clamp(
    Math.floor(((topLeft.y - bounds.y) * meta.imageH) / bounds.height),
    0,
    meta.imageH,
  );
  const right = clamp(
    Math.ceil(((bottomRight.x - bounds.x) * meta.imageW) / bounds.width),
    0,
    meta.imageW,
  );
  const bottom = clamp(
    Math.ceil(((bottomRight.y - bounds.y) * meta.imageH) / bounds.height),
    0,
    meta.imageH,
  );
  if (right <= x || bottom <= y) return null;
  return { capture, region: { x, y, width: right - x, height: bottom - y } };
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
  return denseVisualFingerprint(bitmap, width, height, region);
}

/** Dense quantized cryptographic digest of an exact screenshot pixel region. */
export function denseVisualFingerprint(
  bitmap: Buffer,
  width: number,
  height: number,
  region: PixelRegion,
): string {
  if (
    width < 1 ||
    height < 1 ||
    bitmap.length < width * height * 4 ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > width ||
    region.y + region.height > height
  ) {
    throw new Error('live desktop evidence region is invalid');
  }
  const pixels = quantizedRegionPixels(bitmap, width, region);
  return digestQuantizedRegion(pixels, region);
}

function captureRegionSnapshot(
  capture: CaptureResult,
  region: PixelRegion,
): {
  captureKey: string;
  pixels: Buffer;
  sampleRegion: PixelRegion;
  fingerprint: string;
} | null {
  const image = nativeImage.createFromBuffer(Buffer.from(capture.jpegBase64, 'base64'));
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width !== capture.meta.imageW || size.height !== capture.meta.imageH) return null;
  const bitmap = image.toBitmap();
  if (bitmap.length < size.width * size.height * 4) return null;
  const sample = quantizedRegionSample(bitmap, size.width, region);
  const sampleRegion = { x: 0, y: 0, width: sample.width, height: sample.height };
  const captureKey = `${capture.meta.displayId}:${size.width}x${size.height}:${region.x},${region.y},${region.width}x${region.height}:${sample.width}x${sample.height}`;
  return {
    captureKey,
    pixels: sample.pixels,
    sampleRegion,
    fingerprint: `${captureKey}:${digestQuantizedRegion(sample.pixels, sampleRegion)}`,
  };
}

export function quantizedRegionSample(
  bitmap: Buffer,
  bitmapWidth: number,
  region: PixelRegion,
): { width: number; height: number; pixels: Buffer } {
  const scale = Math.min(1, Math.sqrt(MAX_VISUAL_SAMPLE_PIXELS / (region.width * region.height)));
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let output = 0;
  for (let sampleY = 0; sampleY < height; sampleY += 1) {
    const startY = region.y + Math.floor((sampleY * region.height) / height);
    const endY = region.y + Math.max(1, Math.floor(((sampleY + 1) * region.height) / height));
    for (let sampleX = 0; sampleX < width; sampleX += 1) {
      const startX = region.x + Math.floor((sampleX * region.width) / width);
      const endX = region.x + Math.max(1, Math.floor(((sampleX + 1) * region.width) / width));
      let first = 0;
      let second = 0;
      let third = 0;
      let count = 0;
      for (let y = startY; y < Math.min(endY, region.y + region.height); y += 1) {
        for (let x = startX; x < Math.min(endX, region.x + region.width); x += 1) {
          const offset = (y * bitmapWidth + x) * 4;
          first += bitmap[offset] ?? 0;
          second += bitmap[offset + 1] ?? 0;
          third += bitmap[offset + 2] ?? 0;
          count += 1;
        }
      }
      pixels[output++] = Math.round(first / Math.max(1, count)) >>> 3;
      pixels[output++] = Math.round(second / Math.max(1, count)) >>> 3;
      pixels[output++] = Math.round(third / Math.max(1, count)) >>> 3;
    }
  }
  return { width, height, pixels };
}

function quantizedRegionPixels(bitmap: Buffer, width: number, region: PixelRegion): Buffer {
  const pixels = Buffer.allocUnsafe(region.width * region.height * 3);
  let output = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[output++] = (bitmap[offset] ?? 0) >>> 3;
      pixels[output++] = (bitmap[offset + 1] ?? 0) >>> 3;
      pixels[output++] = (bitmap[offset + 2] ?? 0) >>> 3;
    }
  }
  return pixels;
}

function digestQuantizedRegion(pixels: Buffer, region: PixelRegion): string {
  return createHash('sha256')
    .update(`${region.width}x${region.height}\0`)
    .update(pixels)
    .digest('hex');
}

/** Ignore only sparse noise or a narrow caret-like vertical transient. */
export function isBoundedTransientChange(
  before: Buffer,
  after: Buffer,
  region: PixelRegion,
): boolean {
  if (before.length !== after.length || before.length !== region.width * region.height * 3)
    return false;
  let changed = 0;
  let minX = region.width;
  let maxX = -1;
  let minY = region.height;
  let maxY = -1;
  for (let pixel = 0; pixel < region.width * region.height; pixel += 1) {
    const offset = pixel * 3;
    if (
      before[offset] === after[offset] &&
      before[offset + 1] === after[offset + 1] &&
      before[offset + 2] === after[offset + 2]
    ) {
      continue;
    }
    changed += 1;
    const x = pixel % region.width;
    const y = Math.floor(pixel / region.width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (changed === 0) return true;
  const area = region.width * region.height;
  if (changed <= Math.max(2, Math.min(16, Math.floor(area * 0.001)))) return true;
  const changedWidth = maxX - minX + 1;
  const changedHeight = maxY - minY + 1;
  return (
    changedWidth <= 3 &&
    changedHeight >= Math.min(6, region.height) &&
    changed <= Math.max(24, Math.min(512, Math.floor(area * 0.02)))
  );
}

function snapshotBytes(snapshots: ReadonlyMap<string, { pixels: Buffer }>): number {
  let total = 0;
  for (const snapshot of snapshots.values()) total += snapshot.pixels.byteLength;
  return total;
}

export function enforceVisualSnapshotBudget<T extends { pixels: Buffer }>(
  snapshots: Map<string, T>,
): void {
  while (snapshots.size > 32 || snapshotBytes(snapshots) > MAX_VISUAL_SNAPSHOT_BYTES) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    snapshots.delete(oldest);
  }
}

function defaultNativePointToDip(
  platform: ReceiverFocusGeometry['platform'],
  point: { x: number; y: number },
): { x: number; y: number } {
  return platform === 'win32' ? screen.screenToDipPoint(point) : point;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
