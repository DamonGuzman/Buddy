import { Component, StrictMode, useEffect } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { MarkdownDocumentView as MarkdownDocument } from '../../shared/ipc';
import { getClicky } from './clicky';
import { MarkdownDocumentView } from './MarkdownDocumentView';
import './markdown.css';

function App({ document }: { document: MarkdownDocument }): ReactNode {
  useEffect(() => {
    const clicky = getClicky();
    void clicky.ready().catch((error: unknown) => {
      console.error('[markdown] ready handshake failed', error);
    });
  }, []);
  return <MarkdownDocumentView document={document} />;
}

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[markdown] render failed', error, info);
    void getClicky().renderFailed(error.message || 'the rich document could not be rendered');
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

async function bootstrap(): Promise<void> {
  const clicky = getClicky();
  try {
    const document = await clicky.getDocument();
    window.document.title = `${document.title} — Buddy`;
    const root = window.document.getElementById('root');
    if (!root) throw new Error('the Markdown document root is missing');
    createRoot(root).render(
      <StrictMode>
        <RenderBoundary>
          <App document={document} />
        </RenderBoundary>
      </StrictMode>,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[markdown] bootstrap failed', error);
    await clicky.renderFailed(detail).catch(() => undefined);
  }
}

void bootstrap();
