/**
 * Typed helpers over the frozen src/shared/ipc.ts channel maps, so main-side
 * registration sites get compile-checked channel names and payload shapes
 * instead of per-site casts.
 *
 * Adoption notes for later waves:
 * - `handle` mirrors the local helper in index.ts (single registration point
 *   for InvokeChannels). It discards the IpcMainInvokeEvent; the one
 *   sender-aware invoke handler ('overlay:get-hover-config' in
 *   windows/overlay.ts) should keep raw `ipcMain.handle`.
 * - `onRendererEvent` passes the IpcMainEvent as a SECOND argument so
 *   sender-aware listeners (windows/overlay.ts routes hover/buddy-move by
 *   `event.sender`) can adopt it too.
 * - Payloads arriving over IPC are still untrusted input from a renderer;
 *   these helpers only replace the hand-written parameter annotations, not
 *   the runtime validation some listeners perform.
 */

import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import type {
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  RendererSendChannel,
  RendererSendEvents,
} from '../shared/ipc';

/** Register a typed ipcMain.handle for one InvokeChannel. */
export function handle<C extends InvokeChannel>(
  channel: C,
  handler: (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>,
): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as InvokeArgs<C>)));
}

/** Register a typed ipcMain.on for one fire-and-forget renderer channel. */
export function onRendererEvent<C extends RendererSendChannel>(
  channel: C,
  listener: (payload: RendererSendEvents[C], event: IpcMainEvent) => void,
): void {
  ipcMain.on(channel, (event, payload) => listener(payload as RendererSendEvents[C], event));
}
