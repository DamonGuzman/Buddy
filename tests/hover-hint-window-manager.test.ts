import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { OverlayHoverHintPresentation } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  createHardenedWindow: vi.fn(),
  hardenedWebPreferences: vi.fn(() => ({ sandbox: true })),
  loadRendererPage: vi.fn(),
  applyMacLiquidGlass: vi.fn(() => true),
}));

vi.mock('../src/main/windows/common', () => ({
  TASKBAR_SAFE_TOPMOST_LEVEL: 'floating',
  createHardenedWindow: mocks.createHardenedWindow,
  hardenedWebPreferences: mocks.hardenedWebPreferences,
  loadRendererPage: mocks.loadRendererPage,
}));

vi.mock('../src/main/windows/harden', () => ({
  CRASH_LOOP_MAX_RECREATES: 2,
  CRASH_LOOP_WINDOW_MS: 1_000,
  CrashLoopGuard: class {},
  recoverOnRenderProcessGone: vi.fn(),
}));

vi.mock('../src/main/windows/mac-liquid-glass', () => ({
  applyMacLiquidGlass: mocks.applyMacLiquidGlass,
}));

const { HoverHintWindow } = await import('../src/main/windows/hover-hint');

function fixture(): {
  manager: InstanceType<typeof HoverHintWindow>;
  parent: ReturnType<typeof fakeParent>;
  child: ReturnType<typeof fakeChild>;
} {
  const parent = fakeParent();
  const child = fakeChild();
  mocks.createHardenedWindow.mockReturnValue(child);
  return {
    manager: new HoverHintWindow(parent as unknown as BrowserWindow),
    parent,
    child,
  };
}

const presentation: OverlayHoverHintPresentation = {
  text: 'hold control+option and talk to me',
  sub: 'tap the hotkey to type',
  fading: false,
  placement: { horizontal: 'right', vertical: 'above' },
  bounds: { x: 610.25, y: 420.5, width: 260.25, height: 58.5 },
};

describe('HoverHintWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('owns an unfocusable child window with whole-window native Liquid Glass', () => {
    const { manager, parent, child } = fixture();

    manager.update(presentation);

    expect(mocks.createHardenedWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        parent,
        transparent: true,
        focusable: false,
        show: false,
        alwaysOnTop: true,
      }),
    );
    expect(mocks.applyMacLiquidGlass).toHaveBeenCalledWith(child, {
      style: 'regular',
      cornerRadius: 14,
      tintColor: '#11182740',
    });
    expect(child.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(mocks.loadRendererPage).toHaveBeenCalledWith(child, 'hover-hint', '?nativeGlass=1');
    expect(child.setBounds).toHaveBeenCalledWith({
      x: 710,
      y: 621,
      width: 261,
      height: 59,
    });
  });

  it('reveals only the matching committed revision and never focuses', () => {
    const { manager, child } = fixture();
    manager.update(presentation);
    child.emitWebContents('did-finish-load');

    const update = child.webContents.send.mock.calls.at(-1)?.[1] as { revision: number };
    manager.didPaint(update.revision - 1, child.webContents.id);
    expect(child.showInactive).not.toHaveBeenCalled();

    manager.didPaint(update.revision, child.webContents.id);
    expect(child.showInactive).toHaveBeenCalledOnce();
    expect(child.focus).not.toHaveBeenCalled();
  });

  it('hides immediately when the overlay withdraws the hint', () => {
    const { manager, child } = fixture();
    manager.update(presentation);
    child.emitWebContents('did-finish-load');
    const update = child.webContents.send.mock.calls.at(-1)?.[1] as { revision: number };
    manager.didPaint(update.revision, child.webContents.id);

    manager.update(null);

    expect(child.hide).toHaveBeenCalledOnce();
    expect(child.webContents.send).toHaveBeenLastCalledWith('hover-hint:update', null);
  });

  it('freezes content and geometry for the complete fade-out', () => {
    const { manager, child } = fixture();
    manager.update(presentation);
    child.emitWebContents('did-finish-load');

    manager.update({
      ...presentation,
      text: 'different exit copy that would reflow',
      sub: 'different exit subcopy',
      fading: true,
      bounds: { x: 700, y: 450, width: 180, height: 42 },
    });

    expect(child.setBounds).toHaveBeenLastCalledWith({
      x: 710,
      y: 621,
      width: 261,
      height: 59,
    });
    expect(child.webContents.send).toHaveBeenLastCalledWith(
      'hover-hint:update',
      expect.objectContaining({
        text: presentation.text,
        sub: presentation.sub,
        fading: true,
      }),
    );
  });
});

function fakeParent() {
  return {
    isDestroyed: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 100, y: 200, width: 1440, height: 900 })),
  };
}

function fakeChild() {
  const windowHandlers = new Map<string, () => void>();
  const webContentsHandlers = new Map<string, () => void>();
  const child = {
    webContents: {
      id: 42,
      send: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => webContentsHandlers.set(event, handler)),
    },
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    setIgnoreMouseEvents: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setBounds: vi.fn(),
    showInactive: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => windowHandlers.set(event, handler)),
    emitWebContents: (event: string) => webContentsHandlers.get(event)?.(),
  };
  return child;
}
