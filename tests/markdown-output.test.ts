import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isMarkdownDocumentPath,
  loadMarkdownDocument,
  MAX_MARKDOWN_BYTES,
} from '../src/main/markdown/document';
import { OutputPresenter } from '../src/main/output-presenter';
import { SystemMarkdownFileOpenController } from '../src/main/markdown/system-file-open';
import { normalizeExternalMarkdownUrl } from '../src/renderer/markdown/link-policy';

vi.mock('../src/renderer/markdown/clicky', () => ({
  getClicky: () => ({
    openExternal: vi.fn(async (_url: string) => undefined),
  }),
}));

const cleanup: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-markdown-output-'));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Markdown output documents', () => {
  it.each([
    '/tmp/report.md',
    '/tmp/REPORT.MD',
    '/tmp/report.markdown',
    '/tmp/REPORT.MarkDown',
    '/tmp/report.mdown',
    '/tmp/REPORT.MKD',
    '/tmp/report.mkdn',
  ])('recognizes the supported extension case-insensitively: %s', (path) => {
    expect(isMarkdownDocumentPath(path)).toBe(true);
  });

  it.each(['/tmp/report', '/tmp/report.txt', '/tmp/report.mdx', '/tmp/report.md.txt', '/tmp/.md'])(
    'does not treat unsupported paths as Markdown: %s',
    (path) => {
      expect(isMarkdownDocumentPath(path)).toBe(false);
    },
  );

  it('loads exact UTF-8 source with a renderer-safe basename title', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'launch-notes.MD');
    const markdown = '# Launch notes\n\n**ready** \u2014 ship it.\n';
    await writeFile(path, markdown, 'utf8');

    await expect(loadMarkdownDocument(path)).resolves.toEqual({
      title: 'launch-notes.MD',
      markdown,
    });
  });

  it('fails fast for a missing document, non-file path, or unsupported extension', async () => {
    const directory = await temporaryDirectory();
    const markdownDirectory = join(directory, 'folder.md');
    await mkdir(markdownDirectory);
    const textPath = join(directory, 'notes.txt');
    await writeFile(textPath, '# not Markdown by contract\n', 'utf8');

    await expect(loadMarkdownDocument(join(directory, 'missing.md'))).rejects.toThrow();
    await expect(loadMarkdownDocument(markdownDirectory)).rejects.toThrow(/regular file|file/i);
    await expect(loadMarkdownDocument(textPath)).rejects.toThrow(/markdown|extension/i);
  });

  it('rejects NUL bytes instead of passing binary content into the rich renderer', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'binary.md');
    await writeFile(path, Buffer.from('# heading\n\0binary payload'));

    await expect(loadMarkdownDocument(path)).rejects.toThrow(/nul|binary/i);
  });

  it('rejects malformed UTF-8 instead of rendering replacement characters', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'malformed.md');
    await writeFile(path, Buffer.from([0x23, 0x20, 0xc3, 0x28]));

    await expect(loadMarkdownDocument(path)).rejects.toThrow(/utf-?8|encoding/i);
  });

  it('rejects symbolic links so the validated output cannot escape its file identity', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.md');
    const linked = join(directory, 'linked.md');
    await writeFile(target, '# target\n', 'utf8');
    await symlink(target, linked, 'file');

    await expect(loadMarkdownDocument(linked)).rejects.toThrow(
      /regular file|symbolic link|symlink/i,
    );
  });

  it('rejects an oversized document instead of reading an unbounded output into the renderer', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'oversized.markdown');
    await writeFile(path, Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61));

    await expect(loadMarkdownDocument(path)).rejects.toThrow(/large|size|limit/i);
  });
});

describe('Markdown external-link policy', () => {
  it.each([
    ['https://Example.COM/docs?q=buddy#start', 'https://example.com/docs?q=buddy#start'],
    ['http://example.com/path', 'http://example.com/path'],
    ['mailto:person@example.com', 'mailto:person@example.com'],
  ])('normalizes an allowed external URL without broadening its protocol: %s', (href, expected) => {
    expect(normalizeExternalMarkdownUrl(href)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    './relative.md',
    '/absolute/local.md',
    'file:///private/report.md',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'buddy://settings',
    'mailto:',
    'https://',
  ])('blocks a non-external or unsafe Markdown target: %s', (href) => {
    expect(normalizeExternalMarkdownUrl(href)).toBeNull();
  });

  it('rejects unreasonably long URLs before parsing them', () => {
    expect(normalizeExternalMarkdownUrl(`https://example.com/${'a'.repeat(8_192)}`)).toBeNull();
  });
});

describe('rich-only Markdown rendering', () => {
  it('renders headings, GFM structures, code, and safe links as rich elements', async () => {
    const { MarkdownDocumentView } = await import('../src/renderer/markdown/MarkdownDocumentView');
    const markdown = [
      '# Launch plan',
      '',
      '**Ship** the renderer with [the docs](https://example.com/docs).',
      '',
      '- [x] Markdown opens in Buddy',
      '- [ ] Native fallback removed',
      '',
      '| Surface | Ready |',
      '| --- | --- |',
      '| Buddy | yes |',
      '',
      '```ts',
      'const ready = true;',
      '```',
    ].join('\n');

    const html = renderToStaticMarkup(
      createElement(MarkdownDocumentView, {
        document: { title: 'launch.md', markdown },
      }),
    );

    expect(html).toContain('<h1>Launch plan</h1>');
    expect(html).toContain('<strong>Ship</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('<input type="checkbox" disabled="" checked=""/>');
    expect(html).toContain('<input type="checkbox" disabled=""/>');
    expect(html).toContain('<pre><code class="language-ts">const ready = true;');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noreferrer"');

    // The renderer presents the parsed document, never a raw/source view.
    expect(html).not.toContain('# Launch plan');
    expect(html).not.toContain('**Ship**');
    expect(html).not.toContain('| Surface | Ready |');
    expect(html).not.toContain('```ts');
    expect(html).not.toContain('[the docs](https://example.com/docs)');
    expect(html).not.toContain('<textarea');
  });

  it('removes raw HTML and scripts instead of displaying or activating them', async () => {
    const { MarkdownDocumentView } = await import('../src/renderer/markdown/MarkdownDocumentView');
    const markdown = [
      '# Safe output',
      '<script>alert("raw-script")</script>',
      '<div onclick="alert(1)">raw-html-marker</div>',
      'Rendered paragraph.',
    ].join('\n\n');

    const html = renderToStaticMarkup(
      createElement(MarkdownDocumentView, {
        document: { title: 'safe.md', markdown },
      }),
    );

    expect(html).toContain('<h1>Safe output</h1>');
    expect(html).toContain('<p>Rendered paragraph.</p>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('raw-script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('raw-html-marker');
  });

  it('renders images as inert alt-text placeholders and unsafe links as plain rich text', async () => {
    const { MarkdownDocumentView } = await import('../src/renderer/markdown/MarkdownDocumentView');
    const markdown = [
      '![architecture diagram](https://tracker.example/pixel.png)',
      '',
      '[local secret](file:///private/report.md)',
      '',
      '[script target](javascript:alert(1))',
    ].join('\n');

    const html = renderToStaticMarkup(
      createElement(MarkdownDocumentView, {
        document: { title: 'safe-assets.md', markdown },
      }),
    );

    expect(html).toContain('class="markdown-image-placeholder"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="architecture diagram"');
    expect(html).toContain('architecture diagram');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.example');

    expect(html).toContain('<span class="markdown-link-blocked">local secret</span>');
    expect(html).toContain('<span class="markdown-link-blocked">script target</span>');
    expect(html).not.toContain('file:///private/report.md');
    expect(html).not.toContain('javascript:');
  });
});

describe('output presentation routing', () => {
  it.each(['/tmp/report.md', '/tmp/REPORT.MD', '/tmp/report.markdown', '/tmp/REPORT.MARKDOWN'])(
    'opens Markdown in Buddy and never asks the OS to choose an app: %s',
    async (path) => {
      const openMarkdown = vi.fn(async (_path: string) => undefined);
      const openNative = vi.fn(async (_path: string) => '');
      const presenter = new OutputPresenter({ openMarkdown, openNative });

      await expect(presenter.present({ kind: 'file', path })).resolves.toEqual({
        surface: 'markdown',
        error: null,
      });
      expect(openMarkdown).toHaveBeenCalledWith(path);
      expect(openNative).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: 'file' as const, path: '/tmp/report.txt' },
    { kind: 'file' as const, path: '/tmp/report.mdx' },
    { kind: 'folder' as const, path: '/tmp/output.md' },
  ])('keeps non-Markdown files and every folder on the native open path: $path', async (output) => {
    const openMarkdown = vi.fn(async (_path: string) => undefined);
    const openNative = vi.fn(async (_path: string) => '');
    const presenter = new OutputPresenter({ openMarkdown, openNative });

    await expect(presenter.present(output)).resolves.toEqual({
      surface: 'native',
      error: null,
    });
    expect(openNative).toHaveBeenCalledWith(output.path);
    expect(openMarkdown).not.toHaveBeenCalled();
  });

  it('reports a Markdown renderer failure without falling back to shell.openPath', async () => {
    const openMarkdown = vi.fn(async (_path: string) => {
      throw new Error('document disappeared');
    });
    const openNative = vi.fn(async (_path: string) => '');
    const presenter = new OutputPresenter({ openMarkdown, openNative });

    await expect(presenter.present({ kind: 'file', path: '/tmp/report.md' })).resolves.toEqual({
      surface: 'markdown',
      error: 'document disappeared',
    });
    expect(openNative).not.toHaveBeenCalled();
  });

  it('preserves native shell errors for non-Markdown outputs', async () => {
    const openMarkdown = vi.fn(async (_path: string) => undefined);
    const openNative = vi.fn(async (_path: string) => 'no application is registered');
    const presenter = new OutputPresenter({ openMarkdown, openNative });

    await expect(presenter.present({ kind: 'file', path: '/tmp/report.pdf' })).resolves.toEqual({
      surface: 'native',
      error: 'no application is registered',
    });
  });
});

describe('operating-system Markdown opens', () => {
  it('queues an early macOS open-file path until the Markdown service is bound', async () => {
    const path = join(await temporaryDirectory(), 'launch notes.md');
    const openMarkdown = vi.fn(async (_path: string) => undefined);
    const reportFailure = vi.fn();
    const controller = new SystemMarkdownFileOpenController(reportFailure);

    expect(controller.enqueue(path)).toBe(true);
    expect(openMarkdown).not.toHaveBeenCalled();

    controller.bind(openMarkdown);
    await vi.waitFor(() => expect(openMarkdown).toHaveBeenCalledWith(path));
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('extracts every registered Markdown family path from Windows launch arguments', async () => {
    const directory = await temporaryDirectory();
    const paths = ['report.md', 'notes.MARKDOWN', 'readme.mdown', 'guide.mkd', 'spec.mkdn'].map(
      (name) => join(directory, name),
    );
    const openMarkdown = vi.fn(async (_path: string) => undefined);
    const controller = new SystemMarkdownFileOpenController(vi.fn());
    controller.bind(openMarkdown);

    expect(
      controller.enqueueArguments(['Buddy.exe', '--allow-file-access', ...paths, 'ignored.txt']),
    ).toBe(true);
    await vi.waitFor(() => expect(openMarkdown).toHaveBeenCalledTimes(paths.length));
    expect(openMarkdown.mock.calls.map(([path]) => path)).toEqual(
      paths.map((path) => resolve(path)),
    );
  });

  it('does not consume a normal second launch with no Markdown document', () => {
    const controller = new SystemMarkdownFileOpenController(vi.fn());

    expect(controller.enqueueArguments(['Buddy.exe', '--hidden'])).toBe(false);
  });

  it('deduplicates a document while it is queued and reports renderer failures', async () => {
    const path = join(await temporaryDirectory(), 'broken.md');
    let rejectOpen: ((error: Error) => void) | undefined;
    const openMarkdown = vi.fn(
      (_path: string) =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );
    const reportFailure = vi.fn();
    const controller = new SystemMarkdownFileOpenController(reportFailure);
    controller.bind(openMarkdown);

    expect(controller.enqueue(path)).toBe(true);
    expect(controller.enqueue(path)).toBe(true);
    await vi.waitFor(() => expect(openMarkdown).toHaveBeenCalledTimes(1));
    rejectOpen?.(new Error('render failed'));
    await vi.waitFor(() =>
      expect(reportFailure).toHaveBeenCalledWith(resolve(path), expect.any(Error)),
    );
  });
});
