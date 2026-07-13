import { describe, expect, it } from 'vitest';
import { listeningBlocksHover } from '../src/main/windows/hover-policy';

describe('listeningBlocksHover', () => {
  it('blocks hover during a push-to-talk hold', () => {
    expect(listeningBlocksHover('listening', false)).toBe(true);
  });

  it('does not block the persistent full-realtime listening state', () => {
    expect(listeningBlocksHover('listening', true)).toBe(false);
  });

  it('does not block non-listening states', () => {
    expect(listeningBlocksHover('idle', false)).toBe(false);
    expect(listeningBlocksHover('speaking', false)).toBe(false);
  });
});
