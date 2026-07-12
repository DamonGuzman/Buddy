/**
 * Typed access to the preload-exposed API. Both renderers get `window.clicky`
 * but with different shapes, so each renderer has its own typed accessor
 * instead of a global `Window` augmentation (they'd collide in one tsconfig).
 */

import type { PanelApi } from '../../shared/ipc';

export const clicky: PanelApi = (window as unknown as { clicky: PanelApi }).clicky;
