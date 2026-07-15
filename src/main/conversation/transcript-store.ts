/**
 * Transcript ring buffer: id-keyed upserts (streaming entries update in
 * place), a shared id sequence for every minted entry id, and the F1 (m5)
 * voice-placeholder flow (a "…" user bubble pushed at commit time and filled
 * in place when the async ASR transcript lands).
 *
 * Pure state + one `onEntry` callback per upsert — the owner mirrors entries
 * to the panel renderer and the session journal there, so this module stays
 * directly unit-testable.
 */

import type { TranscriptEntry } from '../../shared/types';
import { pushCapped } from '../util/guards';

export class TranscriptStore {
  private entries: TranscriptEntry[] = [];
  private entrySeq = 0;
  /** F1 fix (m5): placeholder user entry awaiting the async ASR transcript. */
  private pendingVoiceEntryId: string | null = null;

  constructor(
    private readonly limit: number,
    private readonly onEntry: (entry: TranscriptEntry) => void,
  ) {}

  /** Snapshot copy, oldest first. */
  list(): TranscriptEntry[] {
    return [...this.entries];
  }

  get(id: string): TranscriptEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Mint a unique entry id: `<prefix>_<epoch ms>_<seq>` (one shared sequence). */
  mintId(prefix: string, at: number = Date.now()): string {
    return `${prefix}_${at}_${(this.entrySeq += 1)}`;
  }

  /** The sequence value of the most recently minted id (caption-id idiom). */
  seq(): number {
    return this.entrySeq;
  }

  /** Ring-buffer upsert; every accepted entry flows through `onEntry`. */
  upsert(entry: TranscriptEntry): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) {
      this.entries = pushCapped(this.entries, entry, this.limit);
    } else {
      this.entries[idx] = entry;
    }
    this.onEntry(entry);
  }

  /**
   * Assistant text upsert that keeps the FIRST timestamp of the item, so a
   * streaming entry doesn't crawl down the transcript as deltas arrive.
   */
  upsertAssistantText(id: string, text: string, streaming: boolean): void {
    const existing = this.get(id);
    this.upsert({
      id,
      role: 'assistant',
      text,
      streaming,
      timestamp: existing?.timestamp ?? Date.now(),
    });
  }

  /**
   * F1 (m5): push the placeholder user bubble NOW, so the user's question can
   * never appear below the assistant's answer (async ASR).
   */
  beginVoicePlaceholder(): void {
    const placeholderId = this.mintId('user_voice');
    this.pendingVoiceEntryId = placeholderId;
    this.upsert({
      id: placeholderId,
      role: 'user',
      text: '…',
      streaming: true,
      timestamp: Date.now(),
    });
  }

  /**
   * F1 (m5): finalize the placeholder voice bubble in place. Returns true iff
   * a pending placeholder existed AND was still in the ring (the caller then
   * skips pushing a fresh entry). The pending id is consumed either way.
   */
  resolvePendingVoice(text: string): boolean {
    if (this.pendingVoiceEntryId === null) return false;
    const id = this.pendingVoiceEntryId;
    this.pendingVoiceEntryId = null;
    const existing = this.get(id);
    if (!existing) return false;
    this.upsert({ ...existing, text, streaming: false });
    return true;
  }

  /**
   * Finalize entries left mid-stream (cancelled response, session rebuild).
   * With a role filter, only that role's streaming entries are finalized.
   */
  finalizeStreaming(role?: TranscriptEntry['role']): void {
    for (const entry of this.entries) {
      if (entry.streaming && (role === undefined || entry.role === role)) {
        this.upsert({ ...entry, streaming: false });
      }
    }
  }
}
