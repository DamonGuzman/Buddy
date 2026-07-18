import type { MarkdownApi } from '../../shared/ipc';

export function getClicky(): MarkdownApi {
  return (window as unknown as { clicky: MarkdownApi }).clicky;
}
