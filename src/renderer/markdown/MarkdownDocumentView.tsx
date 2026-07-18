import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MarkdownDocumentView as MarkdownDocument } from '../../shared/ipc';
import { getClicky } from './clicky';
import { normalizeExternalMarkdownUrl } from './link-policy';

export interface MarkdownDocumentViewProps {
  document: MarkdownDocument;
}

export function MarkdownDocumentView({ document }: MarkdownDocumentViewProps): ReactNode {
  return (
    <div className="document-shell">
      <header className="document-header">
        <div className="buddy-mark">buddy</div>
        <div className="document-title" title={document.title}>
          {document.title}
        </div>
      </header>
      <main className="document-scroll">
        <article className="markdown-body" aria-label={`Rendered Markdown: ${document.title}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
              img: ({ alt }) => (
                <span className="markdown-image-placeholder" role="img" aria-label={alt || 'image'}>
                  <span aria-hidden="true">▧</span> {alt || 'image'}
                </span>
              ),
            }}
          >
            {document.markdown}
          </ReactMarkdown>
        </article>
      </main>
    </div>
  );
}

function MarkdownLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}): ReactNode {
  const external = normalizeExternalMarkdownUrl(href);
  if (external === null) {
    return <span className="markdown-link-blocked">{children}</span>;
  }

  return (
    <a
      href={external}
      onClick={(event) => {
        event.preventDefault();
        void getClicky()
          .openExternal(external)
          .catch((error: unknown) => {
            console.error('[markdown] external link failed', error);
          });
      }}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
