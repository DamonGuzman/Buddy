import { describe, expect, it } from 'vitest';
import { HelperBuddyBrowserPreviewStore } from '../src/main/agents/helper-buddy-browser-previews';
import type { CaptureResult } from '../src/main/capture';

function capture(label: string, width = 1024, height = 768): CaptureResult {
  return {
    meta: {
      screenIndex: 0,
      displayId: -1,
      imageW: width,
      imageH: height,
      displayBounds: { x: 0, y: 0, width, height },
      scaleFactor: 1,
      isActive: true,
    },
    jpegBase64: Buffer.from(label).toString('base64'),
  };
}

describe('HelperBuddyBrowserPreviewStore', () => {
  it('retains only the latest ephemeral frame per active helper and publishes close tombstones', () => {
    const store = new HelperBuddyBrowserPreviewStore(() => 1_234);

    const first = store.update('helper-buddy-a', capture('first'));
    const second = store.update('helper-buddy-a', capture('second', 800, 600));
    store.update('helper-buddy-b', capture('other'));

    expect(first).toMatchObject({ revision: 1, helperBuddyId: 'helper-buddy-a' });
    expect(second.preview).toEqual({
      helperBuddyId: 'helper-buddy-a',
      imageDataUrl: `data:image/jpeg;base64,${Buffer.from('second').toString('base64')}`,
      width: 800,
      height: 600,
      capturedAt: 1_234,
    });
    expect(store.snapshot()).toMatchObject({
      revision: 3,
      previews: [{ helperBuddyId: 'helper-buddy-a' }, { helperBuddyId: 'helper-buddy-b' }],
    });

    expect(store.update('helper-buddy-a', null)).toEqual({
      revision: 4,
      helperBuddyId: 'helper-buddy-a',
      preview: null,
    });
    expect(store.snapshot()).toMatchObject({
      revision: 4,
      previews: [{ helperBuddyId: 'helper-buddy-b' }],
    });
  });

  it('fails fast for malformed frame data', () => {
    const store = new HelperBuddyBrowserPreviewStore();
    expect(() => store.update('helper-buddy-a', capture('', 0, 768))).toThrow(
      'preview image is empty',
    );
    expect(() => store.update(' helper-buddy-a', capture('valid'))).toThrow('canonical');
  });
});
