/**
 * auth-source (M13-core): the grounding-auth abstraction shared by the REST
 * grounder and the conversation dispatch. Two arms:
 *
 *   - `apiKey`      — the metered OpenAI platform key (settings.getApiKey),
 *                     used against `api.openai.com/v1/responses`. This is the
 *                     ONLY arm the realtime session ever uses (a ChatGPT
 *                     subscription cannot open a realtime WS — see
 *                     realtime/session.ts).
 *   - `chatgptCodex`— the user's ChatGPT-plan credentials from the Codex CLI,
 *                     used against `chatgpt.com/backend-api/codex/responses`
 *                     with gpt-5.6-sol. Bearer resolution is async (lazy
 *                     token refresh); the account id + plan ride alongside.
 *
 * `resolveGroundingAuth` picks Codex-sub when it is signed in AND valid, else
 * the API key, else null (no grounding auth at all — the raw model point
 * stands). It is PURE / injectable: pass in the api-key getter and a codex
 * provider so it unit-tests without Electron or the network.
 */

import type { CodexAuth } from './codex-auth';

/** Which grounding backend a resolved AuthSource drives. */
export type AuthSourceKind = 'apiKey' | 'chatgptCodex';

/** The metered platform-key arm. */
export interface ApiKeyAuthSource {
  kind: 'apiKey';
  /** Decrypted platform key, or null when none is stored. */
  getApiKey(): string | null;
}

/** The ChatGPT-subscription arm (grounding only; never realtime). */
export interface ChatGptCodexAuthSource {
  kind: 'chatgptCodex';
  /** Resolve a guaranteed-usable bearer (awaits a refresh if near expiry). */
  getBearer(): Promise<string>;
  accountId: string;
  planType: string;
}

export type AuthSource = ApiKeyAuthSource | ChatGptCodexAuthSource;

/** The narrow slice of CodexAuth the resolver needs (injectable for tests). */
export type CodexProvider = Pick<CodexAuth, 'getCodexAuth' | 'getBearer'>;

export interface ResolveGroundingAuthInputs {
  /** Decrypted platform key getter (settings.getApiKey). */
  getApiKey: () => string | null;
  /** Codex-sub provider (getCodexAuthProvider() in the app). */
  codex: CodexProvider;
  /**
   * Force the API-key arm even when Codex-sub is available. Wired to
   * `CLICKY_NO_CODEX_SUB=1` in the app for eval A/B; defaults false.
   */
  preferApiKey?: boolean;
}

/**
 * Choose the grounding auth for the next call.
 *
 * Precedence: Codex-sub (signed in + valid) > API key (present) > null.
 * `preferApiKey` demotes Codex-sub below the key (A/B). When Codex-sub is
 * signed in but its token is invalid AND no refresh can be forced synchronously
 * here, we still return the Codex arm ONLY if `getCodexAuth()` reported it
 * usable — otherwise we fall through to the key, so an expired sub never
 * strands grounding.
 */
export function resolveGroundingAuth(inputs: ResolveGroundingAuthInputs): AuthSource | null {
  const { getApiKey, codex, preferApiKey } = inputs;

  const codexInfo = preferApiKey === true ? null : codex.getCodexAuth();
  if (codexInfo !== null) {
    return {
      kind: 'chatgptCodex',
      getBearer: () => codex.getBearer(),
      accountId: codexInfo.accountId,
      planType: codexInfo.planType,
    };
  }

  const key = getApiKey();
  if (key !== null && key.length > 0) {
    return { kind: 'apiKey', getApiKey };
  }

  return null;
}
