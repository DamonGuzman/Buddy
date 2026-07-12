/**
 * Endpoint resolution: the real OpenAI Realtime URL, unless an explicit
 * urlOverride is given or CLICKY_MOCK_URL is set — then the same client talks
 * to tools/mock-realtime instead (no auth headers).
 */

import { ENV_MOCK_URL, REALTIME_BASE_URL } from '../../shared/constants';

export interface RealtimeEndpoint {
  url: string;
  /** True when urlOverride / CLICKY_MOCK_URL is in effect (skip auth headers). */
  isMock: boolean;
}

export function resolveEndpoint(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  urlOverride?: string,
): RealtimeEndpoint {
  if (urlOverride !== undefined && urlOverride.length > 0) {
    return { url: urlOverride, isMock: true };
  }
  const mockUrl = env[ENV_MOCK_URL];
  if (mockUrl !== undefined && mockUrl.length > 0) {
    return { url: mockUrl, isMock: true };
  }
  return { url: `${REALTIME_BASE_URL}?model=${encodeURIComponent(model)}`, isMock: false };
}
