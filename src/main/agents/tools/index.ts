import type { AgentToolSpec, AgentToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { webFetchTool } from './web-fetch';
import { browserTools } from './browser';
import { filesystemTools } from './filesystem';

const tools = [webFetchTool, scratchpadTool, readScreenTool];
const browserByName = new Map(browserTools.map((tool) => [tool.definition.name, tool]));
const filesystemByName = new Map(filesystemTools.map((tool) => [tool.definition.name, tool]));
const byName = new Map(
  [...tools, ...browserTools, ...filesystemTools].map((tool) => [tool.definition.name, tool]),
);

export function agentToolDefinitions(
  browserEnabled = false,
  filesystemEnabled = false,
): AgentToolDefinition[] {
  if (filesystemEnabled) return filesystemTools.map((tool) => tool.definition);
  return [
    { type: 'web_search' },
    ...tools.map((tool) => tool.definition),
    ...(browserEnabled ? browserTools.map((tool) => tool.definition) : []),
  ];
}
export function findAgentTool(
  name: string,
  browserEnabled = false,
  filesystemEnabled = false,
): AgentToolSpec | undefined {
  if (browserByName.has(name) && !browserEnabled) return undefined;
  if (filesystemByName.has(name) && !filesystemEnabled) return undefined;
  if (filesystemEnabled && !filesystemByName.has(name)) return undefined;
  return byName.get(name);
}

export { isBrowserActionTool, isBrowserTool } from './browser';
