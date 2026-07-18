/**
 * The two helper-buddy tools the models call (voice and text paths share
 * them): `spawn_helper_buddy` builds a brief from the current turn (active-screen
 * screenshot + recent transcript) and starts a background worker;
 * `check_helper_buddies` returns a compact, read-only foreground view of active and
 * recent helper-buddy work (never their full output or sources).
 */

import { randomUUID } from 'node:crypto';
import type { HelperBuddyBrief, HelperBuddySpawnResult } from '../agents/types';
import type { CaptureResult } from '../capture';
import type { ErrorKind } from '../errors';
import { asRecord, asString } from '../util/guards';
import type { HelperBuddyContinuationMode } from './helper-buddy-continuations';
import type { HelperBuddiesPort } from './ports';
import type { TranscriptStore } from './transcript-store';

export interface HelperBuddyToolsDeps {
  /** Null when helper buddies are not wired up (focused conversation tests). */
  helperBuddies: HelperBuddiesPort | null;
  transcript: TranscriptStore;
  /** Captures of the turn that asked to spawn (screenshot for the brief). */
  turnCaptures: () => CaptureResult[];
  /** Remember which transport delegated the run (continuation routing). */
  noteOrigin: (helperBuddyId: string, mode: HelperBuddyContinuationMode) => void;
  /** Route actionable helper-buddy gates through the same persistent error policy. */
  surfaceError: (kind: ErrorKind) => void;
  /** Picker-backed read grant and lazy staging task prepared for every helper buddy. */
  prepareFilesystem: (
    task: string,
    helperBuddyId: string,
  ) => Promise<{ taskId: string; rootName: string }>;
  /** Release a prepared workspace when manager admission fails. */
  failFilesystem: (taskId: string, reason: string) => Promise<void>;
}

export class HelperBuddyTools {
  constructor(private readonly deps: HelperBuddyToolsDeps) {}

  async spawnHelperBuddy(value: unknown, mode: HelperBuddyContinuationMode): Promise<object> {
    const { helperBuddies, transcript, noteOrigin } = this.deps;
    if (helperBuddies === null) return { error: 'helper buddies are unavailable' };
    const args = asRecord(value) ?? {};
    const task = asString(args['task']).trim().slice(0, 2_000);
    if (!task) return { error: 'task is required' };
    const why = asString(args['why']).trim().slice(0, 1_000);
    const captures = this.deps.turnCaptures();
    const capture = captures.find((item) => item.meta.isActive) ?? captures[0];
    const transcriptEntries = transcript.list();
    const latestUserEntry = [...transcriptEntries].reverse().find((entry) => entry.role === 'user');
    if (latestUserEntry?.streaming)
      return { error: 'the original user request is still being transcribed' };
    const userRequest = latestUserEntry?.text.trim().slice(0, 2_000);
    if (!userRequest) return { error: 'the original user request is unavailable' };
    const id = `helper_buddy_${randomUUID()}`;
    if (!helperBuddies.isReady()) {
      this.deps.surfaceError('helper_buddy_not_signed_in');
      return { error: 'helper buddies need chatgpt sign-in' };
    }
    let filesystem: { taskId: string; rootName: string };
    try {
      filesystem = await this.deps.prepareFilesystem(task, id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const brief: HelperBuddyBrief = {
      id,
      userRequest,
      task,
      filesystem,
      ...(why ? { why } : {}),
      ...(capture ? { screenshot: { jpegBase64: capture.jpegBase64, meta: capture.meta } } : {}),
      recentTranscript: transcriptEntries
        .slice(-6)
        .map((entry) => `${entry.role === 'assistant' ? 'buddy' : entry.role}: ${entry.text}`)
        .join('\n')
        .slice(-1_500),
      createdAt: Date.now(),
    };
    let result: HelperBuddySpawnResult;
    try {
      result = helperBuddies.spawn(brief);
    } catch (error) {
      const startFailure = error instanceof Error ? error.message : String(error);
      const cleanupFailure = await this.failFilesystem(filesystem.taskId, startFailure);
      return {
        error: cleanupFailure
          ? `helper buddy could not start: ${startFailure}; filesystem cleanup failed: ${cleanupFailure}`
          : `helper buddy could not start: ${startFailure}`,
      };
    }
    if (result.ok) {
      noteOrigin(result.helperBuddyId, mode);
      return { ok: true, helper_buddy_id: result.helperBuddyId };
    }
    const failure =
      result.reason === 'not_signed_in'
        ? 'Buddy needs ChatGPT sign-in.'
        : result.reason === 'filesystem_unavailable'
          ? 'Filesystem execution is unavailable.'
          : 'Browser execution is unavailable.';
    if (result.reason === 'not_signed_in') {
      this.deps.surfaceError('helper_buddy_not_signed_in');
    }
    const cleanupFailure = await this.failFilesystem(filesystem.taskId, failure);
    if (cleanupFailure) {
      return {
        error: `helper buddy could not start: ${failure}; filesystem cleanup failed: ${cleanupFailure}`,
      };
    }
    if (result.reason === 'filesystem_unavailable')
      return { error: 'filesystem use is unavailable for helper buddies right now' };
    if (result.reason === 'not_signed_in') return { error: 'helper buddies need chatgpt sign-in' };
    return { error: 'helper buddy admission rejected an unsupported browser request' };
  }

  /** Release a prepared filesystem task without ever abandoning the model tool call. */
  private async failFilesystem(taskId: string, reason: string): Promise<string | null> {
    try {
      await this.deps.failFilesystem(taskId, reason);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Compact, read-only foreground view of active and recent background work. */
  checkHelperBuddies(value: unknown): object {
    const { helperBuddies } = this.deps;
    if (helperBuddies === null) return { error: 'helper buddies are unavailable' };
    const args = asRecord(value) ?? {};
    const helperBuddyId = asString(args['helper_buddy_id']).trim().slice(0, 200);
    const all = helperBuddies.list();
    const selected = helperBuddyId
      ? all.filter((helperBuddy) => helperBuddy.id === helperBuddyId)
      : [
          ...all.filter(
            (helperBuddy) => helperBuddy.status === 'queued' || helperBuddy.status === 'running',
          ),
          ...all
            .filter(
              (helperBuddy) => helperBuddy.status !== 'queued' && helperBuddy.status !== 'running',
            )
            .slice(0, 5),
        ];
    if (helperBuddyId && selected.length === 0) {
      return { error: 'helper buddy not found', helper_buddy_id: helperBuddyId };
    }
    const now = Date.now();
    return {
      ok: true,
      helper_buddies: selected.map((helperBuddy) => ({
        helper_buddy_id: helperBuddy.id,
        task: helperBuddy.task.slice(0, 500),
        status: helperBuddy.status,
        elapsed_ms: Math.max(0, (helperBuddy.finishedAt ?? now) - helperBuddy.createdAt),
        ...(helperBuddy.step !== undefined ? { step: helperBuddy.step } : {}),
        ...(helperBuddy.steps.length > 0
          ? { latest_activity: helperBuddy.steps.at(-1)?.label.slice(0, 500) ?? '' }
          : {}),
        ...(helperBuddy.summary ? { summary: helperBuddy.summary.slice(0, 1_000) } : {}),
        ...(helperBuddy.error ? { error: helperBuddy.error.slice(0, 500) } : {}),
      })),
    };
  }
}
