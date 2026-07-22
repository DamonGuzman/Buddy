import { resolve } from 'node:path';
import { isMarkdownDocumentPath } from './document';

export type OpenMarkdownDocument = (path: string) => Promise<void>;
export type ReportMarkdownOpenFailure = (path: string, error: unknown) => void;

/**
 * Serializes Markdown documents delivered by the operating system.
 *
 * macOS can emit `open-file` before Electron is ready, while Windows delivers
 * the document path through the first or second process argv. Keeping that
 * timing boundary here ensures neither launch path can race service startup.
 */
export class SystemMarkdownFileOpenController {
  private readonly pendingPaths: string[] = [];
  private readonly queuedPaths = new Set<string>();
  private openMarkdown: OpenMarkdownDocument | null = null;
  private draining = false;

  constructor(private readonly reportFailure: ReportMarkdownOpenFailure) {}

  bind(openMarkdown: OpenMarkdownDocument): void {
    if (this.openMarkdown !== null) {
      throw new Error('the system Markdown file opener is already bound');
    }
    this.openMarkdown = openMarkdown;
    this.drain();
  }

  /** Returns true when argv contained at least one supported Markdown path. */
  enqueueArguments(argv: readonly string[]): boolean {
    const paths = argv.filter(isMarkdownDocumentPath);
    for (const path of paths) this.enqueue(path);
    return paths.length > 0;
  }

  /** Returns false for file types Buddy did not register itself to open. */
  enqueue(path: string): boolean {
    if (!isMarkdownDocumentPath(path)) return false;

    const absolutePath = resolve(path);
    if (!this.queuedPaths.has(absolutePath)) {
      this.queuedPaths.add(absolutePath);
      this.pendingPaths.push(absolutePath);
      this.drain();
    }
    return true;
  }

  private drain(): void {
    if (this.draining || this.openMarkdown === null) return;
    this.draining = true;
    void this.drainPending();
  }

  private async drainPending(): Promise<void> {
    try {
      while (this.openMarkdown !== null) {
        const path = this.pendingPaths.shift();
        if (path === undefined) break;

        try {
          await this.openMarkdown(path);
        } catch (error) {
          this.reportFailure(path, error);
        } finally {
          this.queuedPaths.delete(path);
        }
      }
    } finally {
      this.draining = false;
      if (this.pendingPaths.length > 0) this.drain();
    }
  }
}
