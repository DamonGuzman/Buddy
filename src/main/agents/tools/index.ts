import type { AgentToolSpec, AgentToolDefinition } from '../types';
import { readScreenTool } from './read-screen';
import { scratchpadTool } from './scratchpad';
import { webFetchTool } from './web-fetch';

const tools = [webFetchTool, scratchpadTool, readScreenTool];
const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

export function agentToolDefinitions(): AgentToolDefinition[] {
  return [{ type: 'web_search' }, ...tools.map((tool) => tool.definition)];
}
export function findAgentTool(name: string): AgentToolSpec | undefined {
  return byName.get(name);
}
