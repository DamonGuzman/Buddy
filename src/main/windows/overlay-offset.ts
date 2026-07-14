import type { PointerCommand, Rect } from '../../shared/types';

/**
 * Translate display-local pointer coordinates into the actual overlay
 * window's local space. macOS may clamp a transparent window below its menu
 * bar, while Windows normally leaves both origins identical.
 */
export function offsetPointerForWindow(
  cmd: PointerCommand,
  displayBounds: Rect,
  windowBounds: Rect,
): PointerCommand {
  if (cmd.type !== 'animate') return cmd;
  const dx = displayBounds.x - windowBounds.x;
  const dy = displayBounds.y - windowBounds.y;
  if (dx === 0 && dy === 0) return cmd;
  return {
    ...cmd,
    points: cmd.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
  };
}

