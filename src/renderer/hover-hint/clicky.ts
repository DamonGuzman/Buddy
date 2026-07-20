import type { HoverHintApi } from '../../shared/ipc';

export const clicky: HoverHintApi = (window as unknown as { clicky: HoverHintApi }).clicky;
