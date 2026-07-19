import type {
  HelperBuddyBrowserPreview,
  HelperBuddyBrowserPreviewSnapshot,
  HelperBuddyBrowserPreviewUpdate,
} from '../../shared/types';
import type { CaptureResult } from '../capture';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';

/**
 * Main-memory-only cache for helper-card browser PiP frames.
 *
 * The revision covers both frames and close tombstones so an overlay bootstrap
 * can never resurrect a browser that closed while its IPC request was in flight.
 */
export class HelperBuddyBrowserPreviewStore {
  private readonly previews = new Map<string, HelperBuddyBrowserPreview>();
  private revision = 0;

  constructor(private readonly now: () => number = Date.now) {}

  update(helperBuddyId: string, capture: CaptureResult | null): HelperBuddyBrowserPreviewUpdate {
    const id = requireCanonicalHelperBuddyId(helperBuddyId);
    this.revision += 1;
    if (capture === null) {
      this.previews.delete(id);
      return { revision: this.revision, helperBuddyId: id, preview: null };
    }

    assertPreviewCapture(capture);
    const preview: HelperBuddyBrowserPreview = {
      helperBuddyId: id,
      imageDataUrl: `data:image/jpeg;base64,${capture.jpegBase64}`,
      width: capture.meta.imageW,
      height: capture.meta.imageH,
      capturedAt: this.now(),
    };
    this.previews.set(id, preview);
    return { revision: this.revision, helperBuddyId: id, preview: { ...preview } };
  }

  snapshot(): HelperBuddyBrowserPreviewSnapshot {
    return {
      revision: this.revision,
      previews: [...this.previews.values()]
        .sort((left, right) => left.helperBuddyId.localeCompare(right.helperBuddyId))
        .map((preview) => ({ ...preview })),
    };
  }
}

function assertPreviewCapture(capture: CaptureResult): void {
  if (!capture.jpegBase64) throw new Error('helper buddy browser preview image is empty');
  if (
    !Number.isInteger(capture.meta.imageW) ||
    capture.meta.imageW <= 0 ||
    !Number.isInteger(capture.meta.imageH) ||
    capture.meta.imageH <= 0
  ) {
    throw new Error('helper buddy browser preview dimensions are invalid');
  }
}
