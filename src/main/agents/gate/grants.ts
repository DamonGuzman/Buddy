import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ApprovalGrant } from '../../../shared/types';
import type { ActionSignature } from './signature';
import { matchesApprovalGrant, normalizeDomain, normalizeTargetDescriptor } from './signature';

export interface ApprovalGrantPersistencePort {
  load(): unknown;
  save(grants: ApprovalGrant[]): void;
}

export interface ApprovalGrantStoreOptions {
  persistence: ApprovalGrantPersistencePort;
  now?: () => number;
  createId?: () => string;
  /** Persistence is fail-soft by design, but errors must remain observable. */
  onPersistenceError?: (error: Error) => void;
  maxGrants?: number;
}

const DEFAULT_MAX_GRANTS = 500;
const MAX_GRANT_FILE_BYTES = 1_000_000;
const MAX_GRANT_ID_LENGTH = 200;
const UNLABELED_TARGET = 'unlabeled target';

/** Atomic, owner-only storage for standing buddy approvals. */
export function createApprovalGrantFilePersistence(path: string): ApprovalGrantPersistencePort {
  const resolved = path.trim();
  if (!resolved) throw new Error('approval grant persistence path is required');
  return {
    load(): unknown {
      if (!existsSync(resolved)) return null;
      if (statSync(resolved).size > MAX_GRANT_FILE_BYTES) {
        throw new Error('approval grant file exceeds the size limit');
      }
      return JSON.parse(readFileSync(resolved, 'utf8'));
    },
    save(grants: ApprovalGrant[]): void {
      mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
      const temporaryPath = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, `${JSON.stringify(grants, null, 2)}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
        chmodSync(temporaryPath, 0o600);
        renameSync(temporaryPath, resolved);
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        throw error;
      }
    },
  };
}

/** Validated standing approval memory. A match is evidence, never a gate bypass. */
export class ApprovalGrantStore {
  private readonly records = new Map<string, ApprovalGrant>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onPersistenceError: (error: Error) => void;
  private readonly maxGrants: number;

  constructor(private readonly options: ApprovalGrantStoreOptions) {
    if (
      !options.persistence ||
      typeof options.persistence.load !== 'function' ||
      typeof options.persistence.save !== 'function'
    ) {
      throw new Error('approval grant persistence port is required');
    }
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.onPersistenceError =
      options.onPersistenceError ??
      ((error) => console.error('[approval-grants] persistence failed:', error.message));
    this.maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS;
    if (!Number.isInteger(this.maxGrants) || this.maxGrants <= 0) {
      throw new Error('maxGrants must be a positive integer');
    }
    this.load();
  }

  list(): ApprovalGrant[] {
    return sortedGrants(this.records.values());
  }

  findMatches(signature: ActionSignature): ApprovalGrant[] {
    return this.list().filter((grant) => matchesApprovalGrant(grant, signature));
  }

  create(signature: ActionSignature): ApprovalGrant {
    if (!isActionKind(signature.actionKind)) throw new Error('approval action kind is invalid');
    const target = normalizeTargetDescriptor(signature.target);
    if (target === UNLABELED_TARGET) {
      throw new Error('approval grants require a grounded target label');
    }
    const normalized: ActionSignature = {
      domain: normalizeDomain(signature.domain),
      actionKind: signature.actionKind,
      target,
    };
    const existing = [...this.records.values()].find((grant) =>
      matchesApprovalGrant(grant, normalized),
    );
    if (existing) return cloneGrant(existing);
    if (this.records.size >= this.maxGrants) {
      throw new Error(`approval grant limit of ${this.maxGrants} reached`);
    }

    const id = this.createId().trim();
    if (!id || id.length > MAX_GRANT_ID_LENGTH || this.records.has(id)) {
      throw new Error('approval grant id must be non-empty, bounded, and unique');
    }
    const timestamp = checkedTimestamp(this.now());
    const grant: ApprovalGrant = {
      id,
      ...normalized,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      timesUsed: 0,
    };
    this.commit(new Map(this.records).set(grant.id, grant));
    return cloneGrant(grant);
  }

  recordUse(id: string): ApprovalGrant {
    const grant = this.records.get(id);
    if (!grant) throw new Error(`unknown approval grant: ${id}`);
    const timestamp = checkedTimestamp(this.now());
    if (timestamp < grant.lastUsedAt) throw new Error('clock moved before the last approval use');
    const updated = { ...grant, lastUsedAt: timestamp, timesUsed: grant.timesUsed + 1 };
    this.commit(new Map(this.records).set(id, updated));
    return cloneGrant(updated);
  }

  revoke(id: string): boolean {
    if (!this.records.has(id)) return false;
    const next = new Map(this.records);
    next.delete(id);
    this.commit(next);
    return true;
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.commit(new Map());
  }

  private load(): void {
    try {
      const parsed = this.options.persistence.load();
      if (parsed === null) return;
      if (!Array.isArray(parsed)) throw new Error('approval grant file must contain an array');
      let invalidRecords = Math.max(0, parsed.length - this.maxGrants);
      for (const value of parsed.slice(0, this.maxGrants)) {
        const grant = parseGrant(value);
        if (grant === null || this.records.has(grant.id)) {
          invalidRecords += 1;
        } else {
          this.records.set(grant.id, grant);
        }
      }
      if (invalidRecords > 0) {
        this.reportPersistenceError(
          new Error(`ignored ${invalidRecords} invalid or duplicate approval grant records`),
        );
      }
    } catch (error) {
      this.records.clear();
      this.reportPersistenceError(asError(error));
    }
  }

  /** Persist first, then publish the in-memory mutation. */
  private commit(next: Map<string, ApprovalGrant>): void {
    try {
      this.options.persistence.save(sortedGrants(next.values()));
    } catch (error) {
      const failure = asError(error);
      this.reportPersistenceError(failure);
      throw failure;
    }
    this.records.clear();
    for (const [id, grant] of next) this.records.set(id, grant);
  }

  private reportPersistenceError(error: Error): void {
    try {
      this.onPersistenceError(error);
    } catch (callbackError) {
      console.error(
        '[approval-grants] persistence error callback failed:',
        asError(callbackError).message,
      );
    }
  }
}

export interface FollowThroughCoverage {
  domain: string;
  expiresAt: number;
  remainingActions: number;
}

export interface ApprovalFollowThroughOptions {
  now?: () => number;
  ttlMs?: number;
  maxActions?: number;
}

interface ActiveCoverage extends FollowThroughCoverage {
  activatedAt: number;
}

/** Run-local coverage for a human-approved confirmation chain. */
export class ApprovalFollowThroughTracker {
  private readonly active = new Map<string, ActiveCoverage>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxActions: number;

  constructor(options: ApprovalFollowThroughOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxActions = options.maxActions ?? 3;
    assertPositiveInteger(this.ttlMs, 'ttlMs');
    assertPositiveInteger(this.maxActions, 'maxActions');
  }

  activate(helperBuddyId: string, domain: string): FollowThroughCoverage {
    const id = checkedHelperBuddyId(helperBuddyId);
    const timestamp = checkedTimestamp(this.now());
    const coverage: ActiveCoverage = {
      domain: normalizeDomain(domain),
      activatedAt: timestamp,
      expiresAt: timestamp + this.ttlMs,
      remainingActions: this.maxActions,
    };
    if (!Number.isSafeInteger(coverage.expiresAt)) {
      throw new Error('approval follow-through expiry exceeds the timestamp range');
    }
    this.active.set(id, coverage);
    return publicCoverage(coverage);
  }

  /** Read-only check for reviewer evidence. It does not spend an action. */
  coverageFor(helperBuddyId: string, domain: string): FollowThroughCoverage | null {
    const id = checkedHelperBuddyId(helperBuddyId);
    const coverage = this.validCoverage(id);
    if (coverage === null) return null;
    return coverage.domain === normalizeDomain(domain) ? publicCoverage(coverage) : null;
  }

  /**
   * Spend coverage only after the flagged action actually executes. Leaving
   * the approved domain ends the chain instead of allowing a later bounce-back.
   */
  recordExecutedAction(helperBuddyId: string, domain: string): boolean {
    const id = checkedHelperBuddyId(helperBuddyId);
    const coverage = this.validCoverage(id);
    if (coverage === null) return false;
    if (coverage.domain !== normalizeDomain(domain)) {
      this.active.delete(id);
      return false;
    }
    coverage.remainingActions -= 1;
    if (coverage.remainingActions === 0) this.active.delete(id);
    return true;
  }

  deactivate(helperBuddyId: string): void {
    this.active.delete(helperBuddyId.trim());
  }

  clear(): void {
    this.active.clear();
  }

  private validCoverage(helperBuddyId: string): ActiveCoverage | null {
    const coverage = this.active.get(helperBuddyId);
    if (!coverage) return null;
    const timestamp = checkedTimestamp(this.now());
    if (timestamp < coverage.activatedAt || timestamp >= coverage.expiresAt) {
      this.active.delete(helperBuddyId);
      return null;
    }
    return coverage;
  }
}

function parseGrant(value: unknown): ApprovalGrant | null {
  if (value === null || typeof value !== 'object') return null;
  const grant = value as Partial<ApprovalGrant>;
  if (
    typeof grant.id !== 'string' ||
    !grant.id.trim() ||
    grant.id.length > MAX_GRANT_ID_LENGTH ||
    typeof grant.domain !== 'string' ||
    !isActionKind(grant.actionKind) ||
    typeof grant.target !== 'string' ||
    typeof grant.createdAt !== 'number' ||
    typeof grant.lastUsedAt !== 'number' ||
    typeof grant.timesUsed !== 'number'
  ) {
    return null;
  }
  const domain = (() => {
    try {
      return normalizeDomain(grant.domain);
    } catch {
      return null;
    }
  })();
  if (
    domain === null ||
    domain !== grant.domain ||
    grant.target === UNLABELED_TARGET ||
    normalizeTargetDescriptor(grant.target) !== grant.target ||
    !validTimestamp(grant.createdAt) ||
    !validTimestamp(grant.lastUsedAt) ||
    grant.lastUsedAt < grant.createdAt ||
    !Number.isSafeInteger(grant.timesUsed) ||
    grant.timesUsed < 0
  ) {
    return null;
  }
  return cloneGrant(grant as ApprovalGrant);
}

function isActionKind(value: unknown): value is ApprovalGrant['actionKind'] {
  return ['form-submit', 'button', 'keyboard-submit', 'navigation'].includes(String(value));
}

function cloneGrant(grant: ApprovalGrant): ApprovalGrant {
  return { ...grant };
}

function sortedGrants(grants: Iterable<ApprovalGrant>): ApprovalGrant[] {
  return [...grants]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt)
    .map(cloneGrant);
}

function publicCoverage(coverage: ActiveCoverage): FollowThroughCoverage {
  return {
    domain: coverage.domain,
    expiresAt: coverage.expiresAt,
    remainingActions: coverage.remainingActions,
  };
}

function checkedHelperBuddyId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error('helper buddy id is required');
  if (id.length > MAX_GRANT_ID_LENGTH) throw new Error('helper buddy id exceeds the size limit');
  return id;
}

function checkedTimestamp(value: number): number {
  if (!validTimestamp(value)) throw new Error('clock returned an invalid timestamp');
  return value;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
