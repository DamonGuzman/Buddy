import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('overlay hover-hint layering', () => {
  it('paints the transient hint and its background in the same renderer layer', () => {
    const overlay = source('../src/renderer/overlay/main.tsx');
    const hintMarkup = overlay.match(/\{hint && \([\s\S]*?\n\s*\)\}/)?.[0];

    expect(hintMarkup).toBeDefined();
    expect(hintMarkup).toContain('className="hint-bubble"');
    expect(hintMarkup).not.toContain('data-liquid-glass-region');
  });

  it('keeps Buddy and its hint above helper cards and browser PiP', () => {
    const css = source('../src/renderer/overlay/overlay.css');

    expect(css).toMatch(/\.buddy-root\s*\{[^}]*z-index:\s*2;/s);
    expect(css).toMatch(/\.helper-buddy-cluster\s*\{[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.hint-bubble\s*\{[^}]*background:\s*rgba\(17, 24, 39, 0\.96\);/s);
  });
});
