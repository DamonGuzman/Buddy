/**
 * Typed access to the preload-exposed API. Each renderer gets `window.clicky`
 * with its own shape, so each has its own typed accessor instead of a global
 * `Window` augmentation (they'd collide in one tsconfig).
 */

import type { WhisperApi } from '../../shared/ipc';

export const clicky: WhisperApi = (window as unknown as { clicky: WhisperApi }).clicky;
