/** Renderer-safe filesystem task state. Native paths never authorize work; opaque grant IDs do. */

export type FilesystemChangeKind = 'created' | 'modified' | 'deleted';

export interface FilesystemChange {
  path: string;
  kind: FilesystemChangeKind;
  /** Regular-file byte counts; omitted for directories and symlinks. */
  beforeBytes?: number;
  afterBytes?: number;
}

export type FilesystemTaskStatus =
  | 'preparing'
  | 'running'
  | 'review'
  | 'publishing'
  | 'published'
  | 'kept'
  | 'undoing'
  | 'undone'
  | 'discarded'
  | 'failed';

/** One picker-issued, process-local capability. The renderer cannot mint this identifier. */
export interface FilesystemSelection {
  id: string;
  name: string;
  displayPath: string;
}

export interface FilesystemTaskView {
  taskId: string;
  rootName: string;
  displayPath: string;
  request: string;
  status: FilesystemTaskStatus;
  createdAt: number;
  agentId?: string;
  summary?: string;
  error?: string;
  changes: FilesystemChange[];
  /** Undo is offered only while the durable transaction is still the live version. */
  canUndo: boolean;
}
