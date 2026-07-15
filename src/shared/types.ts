/**
 * Shared domain types for Clicky — a barrel over the focused modules in
 * `src/shared/types/`. Every symbol that has ever been importable from
 * './types' still is; new code may import from the submodules directly.
 *
 * This file is part of the frozen `src/shared/*` contract (see
 * docs/ARCHITECTURE.md §5, §9). Change only via integration/orchestrator-
 * approved edits.
 */

export * from './types/agents';
export * from './types/actionable-error';
export * from './types/audio';
export * from './types/capture';
export * from './types/debug';
export * from './types/overlay';
export * from './types/permissions';
export * from './types/pointer';
export * from './types/settings';
export * from './types/timings';
