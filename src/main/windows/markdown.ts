import { app, ipcMain, shell } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MarkdownDocumentView } from '../../shared/ipc';
import { normalizeExternalMarkdownUrl } from '../../shared/markdown';
import { loadMarkdownDocument } from '../markdown/document';
import { createHardenedWindow, hardenedWebPreferences, loadRendererPage } from './common';

const RENDER_READY_TIMEOUT_MS = 15_000;

interface MarkdownWindowRecord {
  contentsId: number;
  win: BrowserWindow;
  document: MarkdownDocumentView;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const MARKDOWN_CHANNELS = [
  'markdown:get-document',
  'markdown:ready',
  'markdown:render-failed',
  'markdown:open-external',
] as const;

/** Owns every normal, focusable rich-document window and its sender-bound content. */
export class MarkdownWindowManager {
  private readonly records = new Map<number, MarkdownWindowRecord>();

  constructor() {
    ipcMain.handle('markdown:get-document', (event) => this.recordFor(event).document);
    ipcMain.handle('markdown:ready', (event) => this.markReady(event));
    ipcMain.handle('markdown:render-failed', (event, detail: unknown) => {
      const record = this.recordFor(event);
      const message =
        typeof detail === 'string' && detail.trim()
          ? detail.trim().slice(0, 1_000)
          : 'the rich document could not be rendered';
      this.fail(record, new Error(message));
    });
    ipcMain.handle('markdown:open-external', async (event, candidate: unknown) => {
      this.recordFor(event);
      if (typeof candidate !== 'string') throw new Error('invalid Markdown link');
      const url = normalizeExternalMarkdownUrl(candidate);
      if (url === null) throw new Error('Buddy blocked an unsafe Markdown link');
      await shell.openExternal(url);
    });
  }

  /** Read and validate first; a rejected Markdown file never flashes raw content or opens natively. */
  async open(path: string): Promise<void> {
    const document = await loadMarkdownDocument(path);
    await app.whenReady();

    return new Promise<void>((resolve, reject) => {
      const iconPath = join(
        app.getAppPath(),
        'build',
        process.platform === 'darwin' ? 'icon.icns' : 'icon.ico',
      );
      const win = createHardenedWindow({
        title: `${document.title} — Buddy`,
        width: 920,
        height: 720,
        minWidth: 560,
        minHeight: 400,
        show: false,
        frame: true,
        resizable: true,
        minimizable: true,
        maximizable: true,
        fullscreenable: true,
        skipTaskbar: false,
        autoHideMenuBar: true,
        backgroundColor: '#0a0b0f',
        ...(existsSync(iconPath) ? { icon: iconPath } : {}),
        webPreferences: hardenedWebPreferences('markdown.js'),
      });
      const timeout = setTimeout(() => {
        const record = this.records.get(win.webContents.id);
        if (record) this.fail(record, new Error('the rich document renderer did not become ready'));
      }, RENDER_READY_TIMEOUT_MS);
      timeout.unref?.();

      const record: MarkdownWindowRecord = {
        contentsId: win.webContents.id,
        win,
        document,
        settled: false,
        resolve,
        reject,
        timeout,
      };
      this.records.set(win.webContents.id, record);

      win.webContents.on(
        'did-fail-load',
        (_event, code, description, validatedUrl, isMainFrame) => {
          if (!isMainFrame) return;
          this.fail(
            record,
            new Error(
              `the rich document renderer failed to load (${code}: ${description}; ${validatedUrl})`,
            ),
          );
        },
      );
      win.on('closed', () => {
        this.records.delete(record.contentsId);
        if (!record.settled) {
          this.settle(record, new Error('the rich document window closed before it was ready'));
        }
      });

      loadRendererPage(win, 'markdown');
    });
  }

  destroy(): void {
    for (const channel of MARKDOWN_CHANNELS) ipcMain.removeHandler(channel);
    for (const record of [...this.records.values()]) {
      if (!record.settled) this.settle(record, new Error('Buddy is shutting down'));
      if (!record.win.isDestroyed()) record.win.destroy();
    }
    this.records.clear();
  }

  private recordFor(event: IpcMainInvokeEvent): MarkdownWindowRecord {
    const record = this.records.get(event.sender.id);
    if (!record || record.win.webContents !== event.sender) {
      throw new Error('this renderer does not own a Markdown document');
    }
    return record;
  }

  private markReady(event: IpcMainInvokeEvent): void {
    const record = this.recordFor(event);
    if (record.settled) return;
    clearTimeout(record.timeout);
    record.settled = true;
    if (!record.win.isDestroyed()) {
      record.win.show();
      record.win.focus();
    }
    record.resolve();
  }

  private fail(record: MarkdownWindowRecord, error: Error): void {
    this.settle(record, error);
    this.records.delete(record.contentsId);
    if (!record.win.isDestroyed()) record.win.destroy();
  }

  private settle(record: MarkdownWindowRecord, error: Error): void {
    if (record.settled) return;
    clearTimeout(record.timeout);
    record.settled = true;
    record.reject(error);
  }
}
