import type { ActionSignature } from './signature';
import { signatureKey } from './signature';

export const DENIAL_HALT_COPY =
  "i kept proposing actions the reviewer wouldn't pass, so i stopped — the details are on my card.";

export type DenialDecision = 'deny' | 'escalate' | 'halt';

export interface DenialStrikeResult {
  decision: DenialDecision;
  targetCount: number;
  totalCount: number;
}

export interface DenialStrikeSnapshot {
  totalCount: number;
  targets: Readonly<Record<string, number>>;
}

export interface DenialStrikeThresholds {
  sameTargetEscalate: number;
  totalHalt: number;
}

const DEFAULT_THRESHOLDS: DenialStrikeThresholds = {
  sameTargetEscalate: 3,
  totalHalt: 5,
};
const MAX_AGENT_ID_LENGTH = 200;
const MAX_TARGET_KEY_LENGTH = 1_000;

interface AgentStrikes {
  total: number;
  targets: Map<string, number>;
}

/** Run-local denial accounting. One instance may safely serve multiple buddies. */
export class DenialStrikeCounter {
  private readonly agents = new Map<string, AgentStrikes>();
  private readonly thresholds: DenialStrikeThresholds;

  constructor(thresholds: Partial<DenialStrikeThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    assertPositiveInteger(this.thresholds.sameTargetEscalate, 'sameTargetEscalate');
    assertPositiveInteger(this.thresholds.totalHalt, 'totalHalt');
  }

  recordDenial(agentId: string, target: ActionSignature | string): DenialStrikeResult {
    const id = agentId.trim();
    if (!id) throw new Error('agent id is required');
    if (id.length > MAX_AGENT_ID_LENGTH) throw new Error('agent id exceeds the size limit');
    const key = typeof target === 'string' ? target.trim() : signatureKey(target);
    if (!key) throw new Error('denial target signature is required');
    if (key.length > MAX_TARGET_KEY_LENGTH)
      throw new Error('denial target signature exceeds the size limit');

    const state = this.agents.get(id) ?? { total: 0, targets: new Map<string, number>() };
    state.total += 1;
    const targetCount = (state.targets.get(key) ?? 0) + 1;
    state.targets.set(key, targetCount);
    this.agents.set(id, state);

    const decision: DenialDecision =
      state.total >= this.thresholds.totalHalt
        ? 'halt'
        : targetCount >= this.thresholds.sameTargetEscalate
          ? 'escalate'
          : 'deny';
    return { decision, targetCount, totalCount: state.total };
  }

  snapshot(agentId: string): DenialStrikeSnapshot {
    const state = this.agents.get(agentId.trim());
    if (!state) return { totalCount: 0, targets: {} };
    return { totalCount: state.total, targets: Object.fromEntries(state.targets) };
  }

  resetAgent(agentId: string): void {
    this.agents.delete(agentId.trim());
  }

  clear(): void {
    this.agents.clear();
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
