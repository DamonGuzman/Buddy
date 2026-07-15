import { describe, expect, it } from 'vitest';
import { hasHardenedRuntime } from '../build/after-sign.mjs';

describe('macOS post-sign verification', () => {
  it('accepts the current codesign CodeDirectory flags format', () => {
    expect(
      hasHardenedRuntime(
        'CodeDirectory v=20500 size=443 flags=0x10000(runtime) hashes=3+7 location=embedded',
      ),
    ).toBe(true);
  });

  it('rejects signatures without the hardened runtime flag', () => {
    expect(
      hasHardenedRuntime(
        'CodeDirectory v=20500 size=443 flags=0x0(none) hashes=3+7 location=embedded',
      ),
    ).toBe(false);
  });
});
