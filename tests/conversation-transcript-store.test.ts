/**
 * TranscriptStore unit tests: ring-buffer upsert semantics, the shared id
 * sequence, timestamp-preserving assistant upserts, the F1 (m5) voice
 * placeholder flow, and streaming finalization.
 */

import { describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from '../src/main/conversation/transcript-store';
import type { TranscriptEntry } from '../src/shared/types';

function entry(id: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id, role: 'user', text: id, streaming: false, timestamp: 1_000, ...over };
}

describe('TranscriptStore', () => {
  it('appends new ids, replaces existing ids in place, and mirrors via onEntry', () => {
    const seen: TranscriptEntry[] = [];
    const store = new TranscriptStore(10, (e) => seen.push(e));
    store.upsert(entry('a'));
    store.upsert(entry('b'));
    store.upsert(entry('a', { text: 'updated' }));

    expect(store.list().map((e) => e.id)).toEqual(['a', 'b']); // position kept
    expect(store.get('a')?.text).toBe('updated');
    expect(seen).toHaveLength(3); // every upsert flows through onEntry
  });

  it('caps the ring at the limit, dropping oldest first', () => {
    const store = new TranscriptStore(3, () => {});
    for (const id of ['a', 'b', 'c', 'd', 'e']) store.upsert(entry(id));
    expect(store.list().map((e) => e.id)).toEqual(['c', 'd', 'e']);
  });

  it('mintId uses one shared sequence across prefixes', () => {
    const store = new TranscriptStore(10, () => {});
    const a = store.mintId('user', 111);
    const b = store.mintId('sys', 222);
    expect(a).toBe('user_111_1');
    expect(b).toBe('sys_222_2');
    expect(store.seq()).toBe(2);
  });

  it('upsertAssistantText keeps the FIRST timestamp while streaming', () => {
    vi.useFakeTimers({ now: 5_000 });
    try {
      const store = new TranscriptStore(10, () => {});
      store.upsertAssistantText('msg_1', 'hel', true);
      vi.setSystemTime(9_000);
      store.upsertAssistantText('msg_1', 'hello', false);
      const done = store.get('msg_1');
      expect(done).toMatchObject({ text: 'hello', streaming: false, timestamp: 5_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('voice placeholder: begins as a streaming "…" bubble and resolves in place', () => {
    const store = new TranscriptStore(10, () => {});
    store.upsert(entry('before'));
    store.beginVoicePlaceholder();
    const placeholder = store.list().at(-1);
    expect(placeholder).toMatchObject({ role: 'user', text: '…', streaming: true });

    expect(store.resolvePendingVoice('what is this?')).toBe(true);
    const resolved = store.list().at(-1);
    expect(resolved).toMatchObject({
      id: placeholder!.id,
      text: 'what is this?',
      streaming: false,
    });
    // The pending id is consumed: a second resolve is a no-op.
    expect(store.resolvePendingVoice('(voice message)')).toBe(false);
  });

  it('resolvePendingVoice returns false when the placeholder was evicted', () => {
    const store = new TranscriptStore(2, () => {});
    store.beginVoicePlaceholder();
    store.upsert(entry('a'));
    store.upsert(entry('b')); // ring of 2: placeholder evicted
    expect(store.resolvePendingVoice('text')).toBe(false);
  });

  it('finalizeStreaming finalizes all roles, or only the given role', () => {
    const store = new TranscriptStore(10, () => {});
    store.upsert(entry('u', { role: 'user', streaming: true }));
    store.upsert(entry('a', { role: 'assistant', streaming: true }));
    store.finalizeStreaming('assistant');
    expect(store.get('a')?.streaming).toBe(false);
    expect(store.get('u')?.streaming).toBe(true);
    store.finalizeStreaming();
    expect(store.get('u')?.streaming).toBe(false);
  });
});
