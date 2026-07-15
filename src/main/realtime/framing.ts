/**
 * Screenshot framing prose — the factual `context:` text that accompanies a
 * turn's screenshots: which screen is active, each screenshot's index + pixel
 * dims, and the coordinate rules. Persona lives in the session instructions,
 * not here.
 *
 * PURE string building, shared verbatim by both model paths:
 * - RealtimeSession.buildImageContent (the input_text part of an image turn),
 * - the Codex text path in conversation.ts (buildCodexFraming).
 * The two call sites produced byte-identical prose before extraction and the
 * mock realtime server keys on the `context:` prefix, so treat the output as
 * a contract — tests/framing.test.ts pins the exact strings.
 */

import type { CaptureMeta } from '../../shared/types';
import { CONTEXT_PREFIX } from './session';

/**
 * Build the framing text for `metas` screenshots plus optional extra context.
 * Returns '' when there is nothing to frame (no screenshots, no context).
 */
export function buildScreenshotFraming(metas: CaptureMeta[], contextText: string): string {
  if (metas.length === 0) {
    return contextText.length > 0 ? `${CONTEXT_PREFIX} ${contextText}` : '';
  }
  const screens = metas
    .map(
      (m) =>
        `screen${m.screenIndex} is ${m.imageW}x${m.imageH} pixels` +
        (m.isActive ? ' (active screen, the cursor is here)' : ''),
    )
    .join('; ');
  // M8.6 (pointing accuracy): explicit coordinate anchors + a worked
  // fraction→pixel example. Live evals showed the model reads the scene
  // correctly but localizes in a mis-scaled coordinate frame; anchoring
  // the convention with landmarks tightens point_at coordinates.
  const anchors = metas
    .map(
      (m) =>
        `screen${m.screenIndex}: top-left corner (0,0), ` +
        `bottom-right corner (${m.imageW},${m.imageH})`,
    )
    .join('; ');
  const first = metas[0]!;
  return (
    `${CONTEXT_PREFIX} ${metas.length} screenshot(s) attached. ${screens}. ` +
    `point_at coordinates must be pixel coordinates within the named screenshot. ` +
    `coordinate anchors — ${anchors}. ` +
    `to point accurately: judge how far across and down the target sits as a fraction ` +
    `of the full screenshot, then multiply by that screenshot's pixel size ` +
    `(e.g. a target 1/3 across and 1/4 down screen${first.screenIndex} is at ` +
    `(${Math.round(first.imageW / 3)},${Math.round(first.imageH / 4)})); ` +
    `commit to the target's actual offset — never default to the middle of the screen.` +
    (contextText.length > 0 ? ` ${contextText}` : '')
  );
}
