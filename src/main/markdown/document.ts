import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

export interface LoadedMarkdownDocument {
  title: string;
  markdown: string;
}

/** Buddy owns common Markdown extensions, independent of platform casing. */
export function isMarkdownDocumentPath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'].includes(extension);
}

/**
 * Read one regular UTF-8 Markdown document before a window is created.
 *
 * The bounded, fail-fast read prevents an accidentally selected device, pipe,
 * binary, or enormous file from turning the document renderer into an opaque
 * hang. Callers must not fall back to a native source editor after failure.
 */
export async function loadMarkdownDocument(path: string): Promise<LoadedMarkdownDocument> {
  if (!isMarkdownDocumentPath(path)) {
    throw new Error(`not a Markdown document: ${basename(path) || path}`);
  }

  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`the Markdown output must not be a symbolic link: ${basename(path) || path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`the Markdown output must be a regular file: ${basename(path) || path}`);
  }
  if (metadata.size > MAX_MARKDOWN_BYTES) {
    throw new Error(
      `the Markdown output is too large to render (${metadata.size.toLocaleString()} bytes; maximum ${MAX_MARKDOWN_BYTES.toLocaleString()})`,
    );
  }

  const file = await open(
    path,
    process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedMetadata = await file.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error('the Markdown output changed while Buddy was opening it');
    }
    if (openedMetadata.size > MAX_MARKDOWN_BYTES) {
      throw new Error(
        `the Markdown output is too large to render (${openedMetadata.size.toLocaleString()} bytes; maximum ${MAX_MARKDOWN_BYTES.toLocaleString()})`,
      );
    }

    // Read through the already-validated handle, with one sentinel byte so a
    // concurrent replacement/growth cannot bypass the size ceiling.
    const bytes = Buffer.alloc(openedMetadata.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const finishedMetadata = await file.stat();
    if (
      bytesRead !== openedMetadata.size ||
      finishedMetadata.size !== openedMetadata.size ||
      finishedMetadata.mtimeMs !== openedMetadata.mtimeMs
    ) {
      throw new Error('the Markdown output changed while Buddy was reading it');
    }
    const content = bytes.subarray(0, bytesRead);
    if (content.includes(0)) {
      throw new Error('the Markdown output contains binary data and cannot be rendered safely');
    }

    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new Error('the Markdown output is not valid UTF-8 and cannot be rendered safely');
    }

    return { title: basename(path), markdown };
  } finally {
    await file.close();
  }
}
