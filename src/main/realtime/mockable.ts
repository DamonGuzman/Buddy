/**
 * Endpoint resolution: the real OpenAI Realtime URL, unless CLICKY_MOCK_URL
 * is set — then the same client talks to tools/mock-realtime instead.
 */

import { ENV_MOCK_URL, REALTIME_BASE_URL } from '../../shared/constants';

export interface RealtimeEndpoint {
  url: string;
  /** True when CLICKY_MOCK_URL is in effect (skip auth headers). */
  isMock: boolean;
}

export function resolveEndpoint(model: string, env: NodeJS.ProcessEnv = process.env): RealtimeEndpoint {
  const mockUrl = env[ENV_MOCK_URL];
  if (mockUrl && mockUrl.length > 0) {
    return { url: mockUrl, isMock: true };
  }
  return { url: `${REALTIME_BASE_URL}?model=${encodeURIComponent(model)}`, isMock: false };
}
