import { describe, expect, it } from 'vitest';
import { hasNativeGlass } from '../src/renderer/native-glass-mode';

describe('whisper native glass renderer mode', () => {
  it('activates only for main-process-confirmed native glass', () => {
    expect(hasNativeGlass('?nativeGlass=1')).toBe(true);
    expect(hasNativeGlass('?source=buddy&nativeGlass=1')).toBe(true);
  });

  it.each(['', '?nativeGlass=0', '?nativeGlass=true', '?nativeGlass', '?nativeGlass=%31%30'])(
    'keeps the cross-platform CSS chrome for %j',
    (search) => {
      expect(hasNativeGlass(search)).toBe(false);
    },
  );
});
