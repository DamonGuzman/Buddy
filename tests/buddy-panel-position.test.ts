import { describe, expect, it } from 'vitest';
import { positionBuddyPanel } from '../src/main/windows/buddy-panel-position';

describe('Buddy-anchored settings placement', () => {
  const workArea = { x: -1440, y: 25, width: 1440, height: 875 };
  const panel = { width: 380, height: 520 };

  it('opens beside Buddy toward the available interior', () => {
    expect(
      positionBuddyPanel({ x: -1402, y: 378, width: 44, height: 44 }, workArea, panel),
    ).toEqual({
      x: -1346,
      y: 140,
    });
    expect(positionBuddyPanel({ x: -82, y: 378, width: 44, height: 44 }, workArea, panel)).toEqual({
      x: -474,
      y: 140,
    });
  });

  it('clamps the panel inside the work area near top and bottom edges', () => {
    expect(positionBuddyPanel({ x: -700, y: 30, width: 1, height: 1 }, workArea, panel).y).toBe(25);
    expect(positionBuddyPanel({ x: -700, y: 890, width: 1, height: 1 }, workArea, panel).y).toBe(
      380,
    );
  });

  it('falls back safely when the work area is smaller than the panel', () => {
    expect(
      positionBuddyPanel(
        { x: 150, y: 100, width: 1, height: 1 },
        { x: 0, y: 0, width: 300, height: 300 },
        panel,
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});
