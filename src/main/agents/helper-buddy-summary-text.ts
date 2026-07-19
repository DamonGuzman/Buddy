/**
 * Pure helpers for the helper-buddy loop (no I/O, no Electron) — the spoken-recap
 * text shaping, the initial handoff message, summary cloning, and the small
 * loop utilities. Unit-tested directly in tests/helper-buddy-summary-text.test.ts.
 */

import type { HelperBuddySummary } from '../../shared/types';
import type { HelperBuddyBrief, HelperBuddyMemoryMetadata, ResponseItem } from './types';

export interface HelperBuddyMemoryCatalog {
  directory: string;
  memories: HelperBuddyMemoryMetadata[];
}

/** Spoken-recap budget: text at or under this passes through untouched. */
const CONCISE_MAX_CHARS = 500;
/**
 * A sentence break must land past this index to be used as the cut point —
 * anything earlier would throw away too much of the recap.
 */
const CONCISE_MIN_SENTENCE_END = 180;
/** Mid-sentence fallback cut, leaving room for the trailing ellipsis. */
const CONCISE_HARD_CUT = 497;

/** Trim a finished helper buddy recap to a speakable length, preferring a sentence boundary. */
export function concise(text: string): string {
  const clean = text.trim();
  if (clean.length <= CONCISE_MAX_CHARS) return clean;
  const cut = clean.slice(0, CONCISE_MAX_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${cut.slice(0, sentence > CONCISE_MIN_SENTENCE_END ? sentence + 1 : CONCISE_HARD_CUT).trim()}…`;
}

/** Drop markdown links / raw urls — the recap is spoken, urls live in `sources`. */
export function stripLinks(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The first user message of a run: task + context + optional handoff screenshot. */
export function buildInitialMessage(
  brief: HelperBuddyBrief,
  memoryCatalog: HelperBuddyMemoryCatalog,
): ResponseItem {
  const content: ResponseItem[] = [
    {
      type: 'input_text',
      text: [
        `task: ${brief.task}`,
        brief.why ? `why/context: ${brief.why}` : '',
        brief.recentTranscript ? `recent conversation:\n${brief.recentTranscript}` : '',
        renderMemoryCatalog(memoryCatalog),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  if (brief.screenshot)
    content.push({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${brief.screenshot.jpegBase64}`,
    });
  return { type: 'message', role: 'user', content };
}

/** Metadata-only skill-style catalog; full Markdown stays on disk until selected. */
export function renderMemoryCatalog(catalog: HelperBuddyMemoryCatalog): string {
  const entries = catalog.memories.map((memory) =>
    [
      '<memory>',
      `<memory_name>${escapeXml(memory.name)}</memory_name>`,
      `<memory_usage>${escapeXml(memory.usage)}</memory_usage>`,
      `<memory_file>${escapeXml(memory.path)}</memory_file>`,
      '</memory>',
    ].join('\n'),
  );
  return [
    '<helper_memories>',
    `<memory_directory>${escapeXml(catalog.directory)}</memory_directory>`,
    '<progressive_disclosure>Use names and usage descriptions only for routing. Load or read only memories relevant to the current task; do not load every memory.</progressive_disclosure>',
    ...(entries.length > 0 ? entries : ['<memory_catalog_empty>true</memory_catalog_empty>']),
    '</helper_memories>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const TERMINAL_STATUSES: readonly HelperBuddySummary['status'][] = ['done', 'failed', 'cancelled'];

/** True once a helper buddy has reached a final status (no further transitions). */
export function isTerminal(status: HelperBuddySummary['status']): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Deep-enough copy for handing a summary across module boundaries. */
export function cloneHelperBuddySummary(summary: HelperBuddySummary): HelperBuddySummary {
  return { ...summary, steps: [...summary.steps], sources: [...(summary.sources ?? [])] };
}

/** Abortable sleep: resolves early (never rejects) when `signal` fires. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
