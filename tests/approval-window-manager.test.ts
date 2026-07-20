import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  getDisplayMatching: vi.fn(() => ({
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 800 },
  })),
  getPrimaryDisplay: vi.fn(() => ({
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 800 },
  })),
}));

vi.mock('electron', () => ({
  app: {},
  screen: {
    getDisplayMatching: electron.getDisplayMatching,
    getPrimaryDisplay: electron.getPrimaryDisplay,
  },
}));

vi.mock('../src/main/windows/common', () => ({
  TASKBAR_SAFE_TOPMOST_LEVEL: 'floating',
  createHardenedWindow: vi.fn(),
  hardenedWebPreferences: vi.fn(),
  loadRendererPage: vi.fn(),
}));

const { ApprovalManager } = await import('../src/main/windows/approval');

function managerWithWindow(senderId = 17): {
  manager: InstanceType<typeof ApprovalManager>;
  win: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { id: number };
    getBounds: ReturnType<typeof vi.fn>;
    getContentSize: ReturnType<typeof vi.fn>;
    setContentSize: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
  };
} {
  const manager = new ApprovalManager();
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: { id: senderId },
    getBounds: vi.fn(() => ({ x: 1000, y: 24, width: 420, height: 600 })),
    getContentSize: vi.fn(() => [420, 600]),
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
  };
  (manager as unknown as { win: typeof win }).win = win;
  return { manager, win };
}

describe('ApprovalManager content sizing', () => {
  beforeEach(() => {
    electron.getDisplayMatching.mockClear();
    electron.getPrimaryDisplay.mockClear();
  });

  it('fits the transparent host to valid renderer content', () => {
    const { manager, win } = managerWithWindow();

    manager.setContentHeight(394, 17);

    expect(win.setContentSize).toHaveBeenCalledWith(420, 394);
    expect(win.setPosition).toHaveBeenCalled();
  });

  it('clamps short and oversized cards to safe work-area bounds', () => {
    const short = managerWithWindow();
    const tall = managerWithWindow();

    short.manager.setContentHeight(100, 17);
    tall.manager.setContentHeight(2_000, 17);

    expect(short.win.setContentSize).toHaveBeenCalledWith(420, 240);
    expect(tall.win.setContentSize).toHaveBeenCalledWith(420, 776);
  });

  it('ignores invalid or foreign renderer resize messages', () => {
    const { manager, win } = managerWithWindow();

    manager.setContentHeight(Number.NaN, 17);
    manager.setContentHeight(394, 999);

    expect(win.setContentSize).not.toHaveBeenCalled();
  });
});
