import { isMarkdownDocumentPath } from './markdown/document';

export interface PresentationOutput {
  kind: 'file' | 'folder';
  path: string;
}

export interface OutputPresentationResult {
  surface: 'markdown' | 'native';
  error: string | null;
}

export interface OutputPresenterDeps {
  openMarkdown(path: string): Promise<void>;
  /** Electron shell.openPath contract: empty string means success. */
  openNative(path: string): Promise<string>;
}

/** Route rich Markdown to Buddy while preserving native viewers for everything else. */
export class OutputPresenter {
  constructor(private readonly deps: OutputPresenterDeps) {}

  async present(output: PresentationOutput): Promise<OutputPresentationResult> {
    if (output.kind === 'file' && isMarkdownDocumentPath(output.path)) {
      try {
        await this.deps.openMarkdown(output.path);
        return { surface: 'markdown', error: null };
      } catch (error) {
        // Strictly no native fallback: on macOS that is exactly how raw
        // Markdown escaped to Xcode in the first place.
        return { surface: 'markdown', error: errorText(error) };
      }
    }

    try {
      const error = await this.deps.openNative(output.path);
      return { surface: 'native', error: error || null };
    } catch (error) {
      return { surface: 'native', error: errorText(error) };
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
