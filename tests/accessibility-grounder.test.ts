import { describe, expect, it } from 'vitest';
import {
  MacAxElementGrounder,
  WindowsUiaElementGrounder,
  createElementGrounder,
} from '../src/main/grounding/accessibility-grounder';
import type { MacAccessibilityResult } from '../src/main/windows/mac-screen-permission';
import type { GroundingService } from '../src/main/grounding/snapper';

const display = {
  displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
  scaleFactor: 2,
};

function macResult(
  candidates: MacAccessibilityResult['candidates'],
  error?: string,
): MacAccessibilityResult {
  return {
    candidates,
    elapsedMs: 18,
    visited: 240,
    windows: 2,
    from: 'cgwindow+ax',
    ...(error !== undefined ? { error } : {}),
  };
}

describe('cross-platform ElementGrounder contract', () => {
  it('selects the platform implementation behind one factory', () => {
    expect(createElementGrounder({ platform: 'darwin', scriptDir: '.', excludePid: 1 }).provider)
      .toBe('ax');
    const windows = createElementGrounder({ platform: 'win32', scriptDir: '.', excludePid: 1 });
    expect(windows.provider).toBe('uia');
    windows.dispose();
  });

  it('macOS considers a named control in the adjacent side-by-side app', async () => {
    const grounder = new MacAxElementGrounder(99, async () =>
      macResult([
        {
          name: 'Export', ct: 'Button', x: 470, y: 280, w: 80, h: 40,
          pid: 10, windowRank: 0,
        },
        {
          name: 'Save', ct: 'Button', x: 690, y: 280, w: 80, h: 40,
          pid: 11, windowRank: 1,
        },
      ]),
    );
    const outcome = await grounder.snap({
      point: { x: 510, y: 300 },
      label: 'the save button',
      display,
    });
    expect(outcome).toMatchObject({
      provider: 'ax',
      matched: true,
      point: { x: 730, y: 300 },
      name: 'Save',
      candidates: 2,
    });
  });

  it('macOS uses front-to-back order only as a tie-breaker', async () => {
    const grounder = new MacAxElementGrounder(99, async () =>
      macResult([
        { name: 'Save', x: 480, y: 280, w: 40, h: 40, pid: 10, windowRank: 0 },
        { name: 'Save', x: 480, y: 280, w: 40, h: 40, pid: 11, windowRank: 2 },
      ]),
    );
    const outcome = await grounder.snap({
      point: { x: 500, y: 300 }, label: 'save', display,
    }, { debug: true });
    expect(outcome.matched).toBe(true);
    expect(outcome.debug?.map((candidate) => candidate.windowRank)).toEqual([0, 2]);
  });

  it('macOS permission failure remains a normal no-match fallback', async () => {
    const grounder = new MacAxElementGrounder(99, async () =>
      macResult([], 'accessibility_permission_required'),
    );
    const outcome = await grounder.snap({
      point: { x: 500, y: 300 }, label: 'save', display,
    });
    expect(outcome).toMatchObject({
      provider: 'ax', matched: false, point: null, timedOut: false,
      error: 'accessibility_permission_required',
    });
  });

  it('Windows converts its native physical result back to global DIP', async () => {
    const fakeService = {
      warmUp(): void {},
      dispose(): void {},
      async snap(): Promise<unknown> {
        return {
          matched: true,
          point: { x: 400, y: 200 },
          name: 'Save',
          score: 1,
          elapsedMs: 8,
          daemonMs: 6,
          candidates: 1,
          timedOut: false,
        };
      },
    } as unknown as GroundingService;
    const grounder = new WindowsUiaElementGrounder('.', 99, fakeService);
    const outcome = await grounder.snap({
      point: { x: 100, y: 100 }, label: 'save', display,
    });
    expect(outcome).toMatchObject({
      provider: 'uia', matched: true, point: { x: 200, y: 100 }, name: 'Save',
    });
  });
});
