import type { ApprovalApi } from '../../shared/ipc';

export const clicky: ApprovalApi = (window as unknown as { clicky: ApprovalApi }).clicky;
