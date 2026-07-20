import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HelperBuddyCluster } from '../src/renderer/overlay/HelperBuddies';
import type { HelperBuddyBrowserPreview, HelperBuddySummary } from '../src/shared/types';

const helperBuddy: HelperBuddySummary = {
  id: 'helper-buddy-preview',
  task: 'compare the two plans in the browser',
  status: 'running',
  createdAt: 1_000,
  step: 2,
  steps: [{ kind: 'browse', label: 'checking the pricing page', at: 1_100 }],
  spoken: false,
  unseen: false,
};

const preview: HelperBuddyBrowserPreview = {
  helperBuddyId: helperBuddy.id,
  imageDataUrl: 'data:image/jpeg;base64,cHJldmlldw==',
  width: 1024,
  height: 768,
  capturedAt: 1_200,
};

function renderCard(options: { hoveredKey: string | null; expandedKey: string | null }): string {
  return renderToStaticMarkup(
    <HelperBuddyCluster
      view={{ shown: [helperBuddy], overflow: [] }}
      anchor={{ x: 900, y: 700 }}
      dir={-1}
      vdir={-1}
      visible
      interactive
      hoveredKey={options.hoveredKey}
      expandedKey={options.expandedKey}
      now={2_000}
      browserPreviews={[preview]}
      cardRef={createRef<HTMLDivElement>()}
      onHelperBuddyClick={vi.fn()}
      onHelperBuddyCancel={vi.fn()}
    />,
  );
}

describe('helper buddy browser PiP', () => {
  it('allows the in-memory JPEG frame through the overlay CSP', () => {
    const html = readFileSync(
      new URL('../src/renderer/overlay/index.html', import.meta.url),
      'utf8',
    );

    expect(html).toContain("img-src 'self' data:");
  });

  it('floats the active browser frame beside the hover card', () => {
    const html = renderCard({ hoveredKey: helperBuddy.id, expandedKey: null });

    expect(html).toContain('class="helper-buddy-surfaces"');
    expect(html).toContain('data-direction="left"');
    expect(html).toContain('aria-label="live browser preview"');
    expect(html).toContain(preview.imageDataUrl);
    expect(html).toContain('</div><div class="helper-buddy-browser-preview"');
    expect(html).not.toContain('data-expanded=""');
  });

  it('presents every browser capture in a consistent 16:9 PiP frame', () => {
    const css = readFileSync(
      new URL('../src/renderer/overlay/overlay.css', import.meta.url),
      'utf8',
    );

    expect(css).toMatch(
      /\.helper-buddy-browser-preview-frame\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9;/s,
    );
    expect(css).toMatch(
      /\.helper-buddy-browser-preview-frame img\s*\{[^}]*object-fit:\s*cover;[^}]*object-position:\s*top center;/s,
    );
  });

  it('keeps the detached browser companion beside click-expanded details', () => {
    const html = renderCard({ hoveredKey: helperBuddy.id, expandedKey: helperBuddy.id });

    expect(html).toContain('data-expanded=""');
    expect(html).toContain('class="helper-buddy-surfaces"');
    expect(html).toContain('aria-label="live browser preview"');
    expect(html).toContain(preview.imageDataUrl);
    expect(html).toContain('</div><div class="helper-buddy-browser-preview"');
  });

  it('does not render browser pixels while the helper card is closed', () => {
    const html = renderCard({ hoveredKey: null, expandedKey: null });

    expect(html).not.toContain('live browser preview');
    expect(html).not.toContain(preview.imageDataUrl);
  });
});
