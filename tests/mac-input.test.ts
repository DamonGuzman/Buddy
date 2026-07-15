import { describe, expect, it, vi } from 'vitest';
import { MacInputController } from '../src/main/computer/mac-input';
import type { MacInputRequest } from '../src/main/windows/mac-screen-permission';
import { inputPointFromDip } from '../src/main/computer/live-desktop-driver';
import { operatorInstructions } from '../src/main/computer/operator';

function harness(options: { trusted?: boolean; platform?: NodeJS.Platform } = {}) {
  const requests: MacInputRequest[] = [];
  const postInput = vi.fn((request: MacInputRequest) => requests.push(request));
  const controller = new MacInputController({
    platform: options.platform ?? 'darwin',
    isTrustedAccessibilityClient: () => options.trusted ?? true,
    postInput,
  });
  return { requests, postInput, controller };
}

describe('MacInputController', () => {
  it('keeps Electron DIP coordinates as CoreGraphics logical points on Retina macOS', () => {
    expect(inputPointFromDip({ x: -10.4, y: 20.6 }, 'darwin')).toEqual({ x: -10, y: 21 });
  });

  it('tells Sol to use Command rather than Control for macOS shortcuts', () => {
    expect(operatorInstructions('darwin')).toContain('META or COMMAND');
    expect(operatorInstructions('darwin')).toContain('CTRL means the distinct Control key');
    expect(operatorInstructions('win32')).not.toContain('this is macOS');
  });

  it('posts rounded click coordinates through the in-process native bridge', async () => {
    const { requests, controller } = harness();
    await controller.click(12.4, 19.6, 'right', 2);

    expect(requests).toEqual([{ action: 'click', x: 12, y: 20, button: 'right', count: 2 }]);
  });

  it.each([
    [
      'move',
      (controller: MacInputController) => controller.move(3, 4),
      { action: 'move', x: 3, y: 4 },
    ],
    [
      'scroll',
      (controller: MacInputController) => controller.scroll(10, -20),
      { action: 'scroll', deltaX: 10, deltaY: -20 },
    ],
    [
      'Unicode text',
      (controller: MacInputController) => controller.typeText('hé😊'),
      { action: 'type_text', text: 'hé😊' },
    ],
    [
      'key chord',
      (controller: MacInputController) => controller.pressKeys(['CMD', 'L']),
      { action: 'press_keys', keys: ['CMD', 'L'] },
    ],
  ] as const)('supports %s requests', async (_name, invoke, expected) => {
    const { requests, controller } = harness();
    await invoke(controller);
    expect(requests).toEqual([expected]);
  });

  it('fails closed and prompts when Accessibility permission is missing', async () => {
    const { postInput, controller } = harness({ trusted: false });
    await expect(controller.click(1, 2)).rejects.toThrow('Accessibility permission is required');
    expect(postInput).not.toHaveBeenCalled();
  });

  it('surfaces native bridge failures and refuses every action after disposal', async () => {
    const failed = harness();
    failed.postInput.mockImplementationOnce(() => {
      throw new Error('Buddy macOS input failed: input_post_permission_required');
    });
    await expect(failed.controller.typeText('blocked')).rejects.toThrow(
      'input_post_permission_required',
    );

    const disposed = harness();
    disposed.controller.dispose();
    await expect(disposed.controller.typeText('pending')).rejects.toThrow(
      'input controller stopped',
    );
    expect(disposed.postInput).not.toHaveBeenCalled();
  });

  it('fails on unsupported platforms before reaching the bridge', async () => {
    const { controller, postInput } = harness({ platform: 'linux' });
    await expect(controller.move(1, 2)).rejects.toThrow('only available on macOS');
    expect(postInput).not.toHaveBeenCalled();
  });

  it('validates action payloads before reaching the bridge', () => {
    const { controller, postInput } = harness();
    expect(() => controller.click(Number.NaN, 0)).toThrow('x must be a finite number');
    expect(() => controller.click(0, 0, 'left', 3)).toThrow('click count');
    expect(() => controller.typeText('')).toThrow('one to 10000');
    expect(() => controller.pressKeys([])).toThrow('one to eight');
    expect(postInput).not.toHaveBeenCalled();
  });
});
