import type { HelperBuddyToolSpec, HelperBuddyToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { firecrawlTools } from './firecrawl';
import { browserTools } from './browser';
import { filesystemTools } from './filesystem';
import { memoryTools } from './memory';
import { withActivityDescription } from './activity-description';

const baseTools = [
  ...firecrawlTools,
  ...memoryTools,
  scratchpadTool,
  readScreenTool,
];
const firecrawlByName = new Map(firecrawlTools.map((tool) => [tool.definition.name, tool]));
const memoryByName = new Map(memoryTools.map((tool) => [tool.definition.name, tool]));
const browserByName = new Map(browserTools.map((tool) => [tool.definition.name, tool]));
const filesystemByName = new Map(filesystemTools.map((tool) => [tool.definition.name, tool]));
const byName = new Map(
  [...baseTools, ...browserTools, ...filesystemTools].map((tool) => [tool.definition.name, tool]),
);

export function helperBuddyToolDefinitions(
  browserEnabled = false,
  filesystemEnabled = false,
): HelperBuddyToolDefinition[] {
  const enabled = filesystemEnabled
    ? [...firecrawlTools, ...memoryTools, ...filesystemTools]
    : [...baseTools, ...(browserEnabled ? browserTools : [])];
  return enabled.map((tool) => withActivityDescription(tool.definition));
}
export function findHelperBuddyTool(
  name: string,
  browserEnabled = false,
  filesystemEnabled = false,
): HelperBuddyToolSpec | undefined {
  if (browserByName.has(name) && !browserEnabled) return undefined;
  if (filesystemByName.has(name) && !filesystemEnabled) return undefined;
  if (
    filesystemEnabled &&
    !filesystemByName.has(name) &&
    !firecrawlByName.has(name) &&
    !memoryByName.has(name)
  )
    return undefined;
  return byName.get(name);
}

export { isBrowserActionTool, isBrowserTool } from './browser';
