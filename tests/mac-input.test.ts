import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MacInputController } from '../src/main/computer/mac-input';
import { inputPointFromDip, operatorInstructions } from '../src/main/computer/operator';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function harness(options: { trusted?: boolean; timeoutMs?: number } = {}) {
  const child = new FakeChild();
  const calls: Array<{ executable: string; args: string[] }> = [];
  const controller = new MacInputController({
    platform: 'darwin',
    timeoutMs: options.timeoutMs ?? 500,
    isTrustedAccessibilityClient: () => options.trusted ?? true,
    spawnProcess: ((executable: string, args: string[]) => {
      calls.push({ executable, args });
      return child;
    }) as never,
  });
  return { child, calls, controller };
}

function requestFrom(args: string[]): Record<string, unknown> {
  return JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
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

  it('passes rounded click coordinates as a non-shell osascript argument', async () => {
    const { child, calls, controller } = harness();
    const result = controller.click(12.4, 19.6, 'right', 2);
    child.emit('exit', 0, null);
    await result;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe('/usr/bin/osascript');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(requestFrom(calls[0]?.args ?? [])).toEqual({
      action: 'click', x: 12, y: 20, button: 'right', count: 2,
    });
  });

  it.each([
    ['move', (controller: MacInputController) => controller.move(3, 4), { action: 'move', x: 3, y: 4 }],
    ['scroll', (controller: MacInputController) => controller.scroll(10, -20), { action: 'scroll', deltaX: 10, deltaY: -20 }],
    ['Unicode text', (controller: MacInputController) => controller.typeText('hé😊'), { action: 'type_text', text: 'hé😊' }],
    ['key chord', (controller: MacInputController) => controller.pressKeys(['CMD', 'L']), { action: 'press_keys', keys: ['CMD', 'L'] }],
  ] as const)('supports %s requests', async (_name, invoke, expected) => {
    const { child, calls, controller } = harness();
    const result = invoke(controller);
    child.emit('exit', 0, null);
    await result;
    expect(requestFrom(calls[0]?.args ?? [])).toEqual(expected);
  });

  it('fails closed and prompts when Accessibility permission is missing', async () => {
    const { calls, controller } = harness({ trusted: false });
    await expect(controller.click(1, 2)).rejects.toThrow('Accessibility permission is required');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a bounded native error and can be disposed while an action is pending', async () => {
    const failed = harness();
    const failure = failed.controller.pressKeys(['NOPE']);
    failed.child.stderr.write('execution error: unsupported key: NOPE\n');
    failed.child.emit('exit', 1, null);
    await expect(failure).rejects.toThrow('unsupported key: NOPE');

    const pending = harness();
    const action = pending.controller.typeText('pending');
    pending.controller.dispose();
    await expect(action).rejects.toThrow('input controller stopped');
    expect(pending.child.kill).toHaveBeenCalledOnce();
  });

  it('validates action payloads before starting a process', () => {
    const { controller, calls } = harness();
    expect(() => controller.click(Number.NaN, 0)).toThrow('x must be a finite number');
    expect(() => controller.click(0, 0, 'left', 3)).toThrow('click count');
    expect(() => controller.pressKeys([])).toThrow('one to eight');
    expect(calls).toHaveLength(0);
  });
});
