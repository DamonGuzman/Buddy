import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, CodexOAuthLoopback, createPkcePair } from '../src/main/auth/oauth-loopback';

const controllers: CodexOAuthLoopback[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); });

describe('ChatGPT loopback PKCE', () => {
  it('builds a strong S256 pair and the expected native-app authorization request', () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    const url = new URL(buildAuthorizeUrl({ state: 'state-1', challenge: pair.challenge }));
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('accepts the matching callback, exchanges the code, and installs tokens', async () => {
    let opened = '';
    const accept = vi.fn(() => true);
    const complete = vi.fn();
    const controller = new CodexOAuthLoopback({
      auth: { acceptOAuthTokens: accept },
      openExternal: async (url) => { opened = url; },
      fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), { status: 200 })) as typeof fetch,
      onComplete: complete,
    });
    controllers.push(controller);
    await expect(controller.start()).resolves.toEqual({ ok: true });
    const state = new URL(opened).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = await fetch(`http://127.0.0.1:1455/auth/callback?code=code-1&state=${encodeURIComponent(state!)}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('signed in');
    expect(accept).toHaveBeenCalledWith('access', 'refresh');
    expect(complete).toHaveBeenCalledOnce();
  });
});
