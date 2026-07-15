import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalGrant } from '../src/shared/types';
import {
  ApprovalFollowThroughTracker,
  ApprovalGrantStore,
  createApprovalGrantFilePersistence,
  type ApprovalGrantPersistencePort,
} from '../src/main/agents/gate/grants';

class MemoryPersistence implements ApprovalGrantPersistencePort {
  saved: ApprovalGrant[] = [];
  constructor(private loaded: unknown = null) {}
  load(): unknown {
    return this.loaded;
  }
  save(grants: ApprovalGrant[]): void {
    this.saved = grants.map((grant) => ({ ...grant }));
    this.loaded = this.saved;
  }
}

const signature = {
  domain: 'https://app.linear.app/issues',
  actionKind: 'form-submit' as const,
  target: 'Create issue (3)',
};

describe('ApprovalGrantStore', () => {
  it('normalizes, deduplicates, matches, accounts for use, and revokes grants', () => {
    let now = 100;
    const persistence = new MemoryPersistence();
    const store = new ApprovalGrantStore({
      persistence,
      now: () => now,
      createId: () => 'grant-1',
    });
    const created = store.create(signature);
    expect(created).toEqual({
      id: 'grant-1',
      domain: 'linear.app',
      actionKind: 'form-submit',
      target: 'create issue',
      createdAt: 100,
      lastUsedAt: 100,
      timesUsed: 0,
    });
    expect(store.create(signature)).toEqual(created);
    expect(store.list()).toHaveLength(1);
    expect(store.findMatches(signature).map((grant) => grant.id)).toEqual(['grant-1']);

    now = 250;
    expect(store.recordUse('grant-1')).toMatchObject({ lastUsedAt: 250, timesUsed: 1 });
    expect(() => store.recordUse('missing')).toThrow('unknown approval grant');
    expect(store.revoke('grant-1')).toBe(true);
    expect(store.revoke('grant-1')).toBe(false);
    expect(persistence.saved).toEqual([]);
  });

  it('refuses standing grants without a grounded target label', () => {
    const store = new ApprovalGrantStore({
      persistence: new MemoryPersistence(),
      now: () => 1,
      createId: () => 'g1',
    });
    expect(() => store.create({ ...signature, target: '' })).toThrow(
      'require a grounded target label',
    );
    expect(store.list()).toEqual([]);
  });

  it('validates persisted grants instead of widening corrupt records', () => {
    const valid: ApprovalGrant = {
      id: 'valid',
      domain: 'linear.app',
      actionKind: 'button',
      target: 'delete issue',
      createdAt: 10,
      lastUsedAt: 20,
      timesUsed: 2,
    };
    const persistence = new MemoryPersistence([
      valid,
      { ...valid, id: 'full-host', domain: 'app.linear.app' },
      { ...valid, id: 'raw-target', target: 'Delete issue (2)' },
      { ...valid, id: 'negative', timesUsed: -1 },
      { ...valid, id: 'wrong-kind', actionKind: 'anything' },
    ]);
    const errors: Error[] = [];
    const store = new ApprovalGrantStore({
      persistence,
      onPersistenceError: (error) => errors.push(error),
    });
    expect(store.list()).toEqual([valid]);
    expect(errors[0]?.message).toBe('ignored 4 invalid or duplicate approval grant records');
  });

  it('keeps load failures non-fatal but rolls back and surfaces failed mutations', () => {
    const errors: Error[] = [];
    const persistence: ApprovalGrantPersistencePort = {
      load() {
        throw new Error('disk unavailable');
      },
      save() {
        throw new Error('disk full');
      },
    };
    const store = new ApprovalGrantStore({
      persistence,
      now: () => 1,
      createId: () => 'g1',
      onPersistenceError: (error) => errors.push(error),
    });
    expect(() => store.create(signature)).toThrow('disk full');
    expect(store.list()).toEqual([]);
    expect(errors.map((error) => error.message)).toEqual(['disk unavailable', 'disk full']);
  });

  it('writes atomically with owner-only file permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-grants-'));
    const path = join(directory, 'approval-grants.json');
    const persistence = createApprovalGrantFilePersistence(path);
    persistence.save([
      {
        id: 'g1',
        domain: 'linear.app',
        actionKind: 'button',
        target: 'create issue',
        createdAt: 1,
        lastUsedAt: 1,
        timesUsed: 0,
      },
    ]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('ApprovalFollowThroughTracker', () => {
  it('covers three executed flagged actions on the same registrable domain without spending reads', () => {
    const now = 1_000;
    const tracker = new ApprovalFollowThroughTracker({ now: () => now });
    expect(tracker.activate('agent-1', 'https://app.linear.app')).toEqual({
      domain: 'linear.app',
      expiresAt: 61_000,
      remainingActions: 3,
    });
    expect(tracker.coverageFor('agent-1', 'other.linear.app')?.remainingActions).toBe(3);
    expect(tracker.coverageFor('agent-1', 'linear.app')?.remainingActions).toBe(3);
    expect(tracker.recordExecutedAction('agent-1', 'linear.app')).toBe(true);
    expect(tracker.coverageFor('agent-1', 'linear.app')?.remainingActions).toBe(2);
    expect(tracker.recordExecutedAction('agent-1', 'linear.app')).toBe(true);
    expect(tracker.recordExecutedAction('agent-1', 'linear.app')).toBe(true);
    expect(tracker.coverageFor('agent-1', 'linear.app')).toBeNull();
  });

  it('expires at 60 seconds and invalidates the chain on a cross-domain action', () => {
    let now = 5_000;
    const tracker = new ApprovalFollowThroughTracker({ now: () => now });
    tracker.activate('agent-1', 'linear.app');
    now = 65_000;
    expect(tracker.coverageFor('agent-1', 'linear.app')).toBeNull();

    now = 70_000;
    tracker.activate('agent-1', 'linear.app');
    expect(tracker.recordExecutedAction('agent-1', 'evil.example')).toBe(false);
    expect(tracker.coverageFor('agent-1', 'linear.app')).toBeNull();
  });

  it('fails fast on invalid configuration and identifiers', () => {
    expect(() => new ApprovalFollowThroughTracker({ ttlMs: 0 })).toThrow('positive integer');
    const tracker = new ApprovalFollowThroughTracker({ now: vi.fn(() => 1) });
    expect(() => tracker.activate('', 'linear.app')).toThrow('agent id is required');
  });
});
