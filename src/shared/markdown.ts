const EXTERNAL_MARKDOWN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Normalize the only Markdown link schemes Buddy may hand to the operating system. */
export function normalizeExternalMarkdownUrl(href: string | undefined): string | null {
  if (!href || href.length > 8_192) return null;
  try {
    const url = new URL(href);
    if (!EXTERNAL_MARKDOWN_PROTOCOLS.has(url.protocol)) return null;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null;
    if (url.protocol === 'mailto:' && !url.pathname) return null;
    return url.toString();
  } catch {
    return null;
  }
}
