import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { CodexAuth } from './codex-auth';

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/auth/callback`;
const FLOW_TIMEOUT_MS = 5 * 60_000;

export interface OAuthLoopbackDeps {
  auth: Pick<CodexAuth, 'acceptOAuthTokens'>;
  openExternal(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  onComplete?(): void;
}

export type OAuthStartResult = { ok: true } | { ok: false; error: string };

export class CodexOAuthLoopback {
  private server: Server | null = null;
  private timeout: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OAuthLoopbackDeps) {}

  async start(): Promise<OAuthStartResult> {
    if (this.server !== null) return { ok: false, error: 'a chatgpt sign-in is already in progress' };
    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(24).toString('base64url');
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/auth/callback') {
        respond(res, 404, 'buddy sign-in page not found');
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      if (returnedState !== state) {
        respond(res, 400, 'buddy blocked this sign-in because its security check did not match.');
        this.stop();
        return;
      }
      if (oauthError || !code) {
        respond(res, 400, 'chatgpt sign-in was cancelled. you can close this tab and try again from buddy.');
        this.stop();
        return;
      }
      // Single-use callback: stop accepting requests before the token exchange
      // so a replay cannot race a second install.
      this.stop();
      void this.exchange(code, verifier).then((ok) => {
        respond(
          res,
          ok ? 200 : 500,
          ok
            ? 'you’re signed in to buddy with chatgpt. you can close this tab.'
            : 'buddy could not finish sign-in. close this tab and try again.',
        );
        if (ok) this.deps.onComplete?.();
      });
    });
    this.server = server;
    const listening = await new Promise<OAuthStartResult>((resolve) => {
      server.once('error', () => resolve({ ok: false, error: 'buddy could not open its local sign-in callback. close any other codex sign-in and try again.' }));
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve({ ok: true }));
    });
    if (!listening.ok) { this.stop(); return listening; }
    this.timeout = setTimeout(() => this.stop(), FLOW_TIMEOUT_MS);
    this.timeout.unref?.();
    try {
      await this.deps.openExternal(buildAuthorizeUrl({ state, challenge }));
      return { ok: true };
    } catch {
      this.stop();
      return { ok: false, error: 'buddy could not open your browser for chatgpt sign-in' };
    }
  }

  stop(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    const server = this.server;
    this.server = null;
    try { server?.close(); } catch { /* already closed */ }
  }

  private async exchange(code: string, verifier: string): Promise<boolean> {
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as Record<string, unknown>;
      const access = typeof payload['access_token'] === 'string' ? payload['access_token'] : '';
      const refresh = typeof payload['refresh_token'] === 'string' ? payload['refresh_token'] : '';
      return this.deps.auth.acceptOAuthTokens(access, refresh);
    } catch {
      return false;
    }
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: { state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  }).toString();
  return url.toString();
}

function respond(res: import('node:http').ServerResponse, status: number, message: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>buddy sign-in</title><body style="background:#09090b;color:#fafafa;font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:480px;padding:32px;text-align:center"><h1 style="font-size:22px">buddy</h1><p style="color:#a1a1aa;line-height:1.6">${escapeHtml(message)}</p></main></body>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char); }
