import { describe, expect, it } from 'vitest';
import {
  hotkeyLabelForPlatform,
  hotkeyTooltipForPlatform,
  supportsComputerUse,
} from '../src/main/platform';

describe('platform presentation and capability seams', () => {
  it('uses native modifier names on macOS', () => {
    expect(hotkeyLabelForPlatform('darwin')).toBe('Control+Option (left option)');
    expect(hotkeyTooltipForPlatform('darwin')).toBe('Control + left Option');
  });

  it('preserves the Windows hotkey wording', () => {
    expect(hotkeyLabelForPlatform('win32')).toBe('Ctrl+Alt (left alt)');
    expect(hotkeyTooltipForPlatform('win32')).toBe('Ctrl + left Alt');
  });

  it('only advertises computer use where a controller exists', () => {
    expect(supportsComputerUse('darwin')).toBe(true);
    expect(supportsComputerUse('win32')).toBe(true);
    expect(supportsComputerUse('linux')).toBe(false);
  });
});
