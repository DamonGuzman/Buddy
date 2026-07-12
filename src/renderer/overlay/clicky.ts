/**
 * Typed access to the preload-exposed API. Both renderers get `window.clicky`
 * but with different shapes, so each renderer has its own typed accessor
 * instead of a global `Window` augmentation (they'd collide in one tsconfig).
 */

import type { OverlayApi } from '../../shared/ipc';

export const clicky: OverlayApi = (window as unknown as { clicky: OverlayApi }).clicky;
