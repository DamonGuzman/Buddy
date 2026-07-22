import type { HelperBuddyToolSpec, HelperBuddyToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { firecrawlTools } from './firecrawl';
import { browserTools } from './browser';
import { filesystemTools } from './filesystem';
import { memoryTools } from './memory';
import { withActivityDescription } from './activity-description';

const tools = [
  ...firecrawlTools,
  ...memoryTools,
  scratchpadTool,
  readScreenTool,
  ...browserTools,
  ...filesystemTools,
];
const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

export function helperBuddyToolDefinitions(): HelperBuddyToolDefinition[] {
  return tools.map((tool) => withActivityDescription(tool.definition));
}
export function findHelperBuddyTool(name: string): HelperBuddyToolSpec | undefined {
  return byName.get(name);
}

export { isBrowserTool } from './browser';
