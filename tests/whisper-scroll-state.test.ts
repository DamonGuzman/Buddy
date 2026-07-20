import { describe, expect, it } from 'vitest';

import {
  SCROLL_BOTTOM_TOLERANCE_PX,
  shouldFollowLatest,
  WhisperScrollFollower,
} from '../src/renderer/whisper/scroll-state';

describe('Whisper scroll following', () => {
  it('follows a history that does not overflow', () => {
    expect(shouldFollowLatest({ scrollTop: 0, scrollHeight: 180, clientHeight: 180 })).toBe(true);
  });

  it('follows at the bottom and within the small rounding tolerance', () => {
    expect(shouldFollowLatest({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 })).toBe(true);
    expect(
      shouldFollowLatest({
        scrollTop: 300 - SCROLL_BOTTOM_TOLERANCE_PX,
        scrollHeight: 500,
        clientHeight: 200,
      }),
    ).toBe(true);
  });

  it('does not pull a reader back down after they scroll upward', () => {
    expect(
      shouldFollowLatest({
        scrollTop: 300 - SCROLL_BOTTOM_TOLERANCE_PX - 1,
        scrollHeight: 500,
        clientHeight: 200,
      }),
    ).toBe(false);
  });

  it('treats elastic negative scroll positions as the top, not the bottom', () => {
    expect(shouldFollowLatest({ scrollTop: -20, scrollHeight: 500, clientHeight: 200 })).toBe(
      false,
    );
  });

  it('pauses before a tiny upward trackpad scroll can race a streaming update', () => {
    const follower = new WhisperScrollFollower();
    const bottom = { scrollTop: 300, scrollHeight: 500, clientHeight: 200 };
    follower.resume(bottom);

    follower.noteWheel(-0.25, bottom);

    expect(follower.shouldFollow()).toBe(false);
  });

  it('does not resume after the upward scroll event even within bottom tolerance', () => {
    const follower = new WhisperScrollFollower();
    follower.resume({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
    follower.noteWheel(-0.5, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 });

    follower.noteScroll({ scrollTop: 299.5, scrollHeight: 500, clientHeight: 200 });

    expect(follower.shouldFollow()).toBe(false);
  });

  it('resumes only after the reader scrolls downward to the bottom', () => {
    const follower = new WhisperScrollFollower();
    follower.resume({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
    follower.noteWheel(-30, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
    follower.noteScroll({ scrollTop: 270, scrollHeight: 500, clientHeight: 200 });

    follower.noteScroll({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });

    expect(follower.shouldFollow()).toBe(true);
  });

  it.each([
    ['ArrowUp', false],
    ['PageUp', false],
    ['Home', false],
    [' ', true],
  ])('pauses synchronously for the upward keyboard gesture %j', (key, shiftKey) => {
    const follower = new WhisperScrollFollower();
    follower.resume({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });

    follower.noteKey(key, shiftKey, { scrollTop: 300, scrollHeight: 500, clientHeight: 200 });

    expect(follower.shouldFollow()).toBe(false);
  });

  it('ignores upward intent when the history has no overflow', () => {
    const follower = new WhisperScrollFollower();
    const metrics = { scrollTop: 0, scrollHeight: 180, clientHeight: 180 };

    follower.noteWheel(-4, metrics);
    follower.noteKey('Home', false, metrics);

    expect(follower.shouldFollow()).toBe(true);
  });
});
