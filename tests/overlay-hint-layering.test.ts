import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('overlay hover-hint layering', () => {
  it('uses the overlay hint only as a hidden measurement surface on macOS', () => {
    const overlay = source('../src/renderer/overlay/main.tsx');
    const hintMarkup = overlay.match(/\{hint && \([\s\S]*?\n\s*\)\}/)?.[0];

    expect(hintMarkup).toBeDefined();
    expect(hintMarkup).toContain('className="hint-bubble"');
    expect(hintMarkup).toContain('data-external-window={clicky.isMacOS');
    expect(overlay).toContain('clicky.sendHoverHint(presentation)');
  });

  it('keeps the in-overlay measurement invisible and restores the glass surface token', () => {
    const css = source('../src/renderer/overlay/overlay.css');

    expect(css).toMatch(/\.hint-bubble\s*\{[^}]*background:\s*var\(--liquid-glass-surface\);/s);
    expect(css).toMatch(/\.hint-bubble\[data-external-window\]\s*\{[^}]*visibility:\s*hidden;/s);
  });

  it('builds a dedicated renderer whose content is composited inside native glass', () => {
    const build = source('../electron.vite.config.ts');
    const manager = source('../src/main/windows/hover-hint.ts');

    expect(build).toContain("'hover-hint': resolve(__dirname, 'src/preload/hover-hint.ts')");
    expect(build).toContain(
      "'hover-hint': resolve(__dirname, 'src/renderer/hover-hint/index.html')",
    );
    expect(manager).toContain('applyMacLiquidGlass(win');
    expect(manager).toContain('focusable: false');
    expect(manager).toContain('win.showInactive()');
  });

  it('fades without translating text or changing its geometry', () => {
    const hintCss = source('../src/renderer/hover-hint/hover-hint.css');
    const fadingRule = hintCss.match(/\.hover-hint-surface\[data-fading\]\s*\{[^}]*\}/s)?.[0];

    expect(fadingRule).toContain('opacity: 0');
    expect(fadingRule).not.toContain('transform:');
  });
});
