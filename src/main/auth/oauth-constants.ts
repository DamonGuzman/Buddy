/**
 * OAuth constants for the ChatGPT / Codex sign-in flows, shared by
 * `codex-auth.ts` (refresh-token grant) and `oauth-loopback.ts`
 * (authorization-code + PKCE loopback). One owner so the two flows can never
 * drift onto different client ids or scopes.
 */

/** OAuth client id the Codex CLI registers as (public; not a secret). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_SCOPE = 'openid profile email offline_access';
