import type { AgentToolSpec, AgentToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { webFetchTool } from './web-fetch';
import { browserTools } from './browser';

const tools = [webFetchTool, scratchpadTool, readScreenTool];
const browserByName = new Map(browserTools.map((tool) => [tool.definition.name, tool]));
const byName = new Map([...tools, ...browserTools].map((tool) => [tool.definition.name, tool]));

export function agentToolDefinitions(browserEnabled = false): AgentToolDefinition[] {
  return [
    { type: 'web_search' },
    ...tools.map((tool) => tool.definition),
    ...(browserEnabled ? browserTools.map((tool) => tool.definition) : []),
  ];
}
export function findAgentTool(name: string, browserEnabled = false): AgentToolSpec | undefined {
  if (browserByName.has(name) && !browserEnabled) return undefined;
  return byName.get(name);
}

export { isBrowserActionTool, isBrowserTool } from './browser';
