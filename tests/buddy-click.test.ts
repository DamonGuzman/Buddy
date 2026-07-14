import { describe, expect, it } from 'vitest';
import { BUDDY_CLICK_RADIUS, isBuddyClick } from '../src/main/windows/buddy-click';

describe('Buddy global click hit-test', () => {
  const bounds = { x: -1440, y: 25, width: 1440, height: 900 };
  const buddy = { x: 1364, y: 780 };

  it('accepts clicks on Buddy in window-local DIP coordinates', () => {
    expect(isBuddyClick({ x: -76, y: 805 }, bounds, buddy)).toBe(true);
    expect(
      isBuddyClick({ x: -76 + BUDDY_CLICK_RADIUS, y: 805 }, bounds, buddy),
    ).toBe(true);
  });

  it('rejects clicks outside Buddy', () => {
    expect(isBuddyClick({ x: -76 + BUDDY_CLICK_RADIUS + 1, y: 805 }, bounds, buddy)).toBe(false);
  });
});
