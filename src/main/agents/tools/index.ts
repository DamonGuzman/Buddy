import type { AgentToolSpec, AgentToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { firecrawlTools } from './firecrawl';
import { browserTools } from './browser';
import { filesystemTools } from './filesystem';
import { withActivityDescription } from './activity-description';

const tools = [...firecrawlTools, scratchpadTool, readScreenTool];
const firecrawlByName = new Map(firecrawlTools.map((tool) => [tool.definition.name, tool]));
const browserByName = new Map(browserTools.map((tool) => [tool.definition.name, tool]));
const filesystemByName = new Map(filesystemTools.map((tool) => [tool.definition.name, tool]));
const byName = new Map(
  [...tools, ...browserTools, ...filesystemTools].map((tool) => [tool.definition.name, tool]),
);

export function agentToolDefinitions(
  browserEnabled = false,
  filesystemEnabled = false,
): AgentToolDefinition[] {
  if (filesystemEnabled)
    return [...firecrawlTools, ...filesystemTools].map((tool) =>
      withActivityDescription(tool.definition),
    );
  return [
    ...tools.map((tool) => withActivityDescription(tool.definition)),
    ...(browserEnabled ? browserTools.map((tool) => withActivityDescription(tool.definition)) : []),
  ];
}
export function findAgentTool(
  name: string,
  browserEnabled = false,
  filesystemEnabled = false,
): AgentToolSpec | undefined {
  if (browserByName.has(name) && !browserEnabled) return undefined;
  if (filesystemByName.has(name) && !filesystemEnabled) return undefined;
  if (filesystemEnabled && !filesystemByName.has(name) && !firecrawlByName.has(name))
    return undefined;
  return byName.get(name);
}

export { isBrowserActionTool, isBrowserTool } from './browser';
