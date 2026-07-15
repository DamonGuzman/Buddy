import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  CodexOAuthLoopback,
  createPkcePair,
  renderPage,
} from '../src/main/auth/oauth-loopback';
import type { OAuthLoopbackDeps } from '../src/main/auth/oauth-loopback';

const controllers: CodexOAuthLoopback[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});

/**
 * GET over a FRESH connection (`agent: false`). `fetch` pools keep-alive
 * sockets per origin, so a later test would silently reuse a socket still
 * attached to an earlier (stopped) flow's server and hit the wrong handler.
 */
function request(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).once('error', reject);
  });
}

/** A started controller with a captured authorize URL and spyable deps. */
async function startFlow(overrides: Partial<OAuthLoopbackDeps> = {}) {
  let opened = '';
  const accept = vi.fn(() => true);
  const complete = vi.fn();
  const controller = new CodexOAuthLoopback({
    auth: { acceptOAuthTokens: accept },
    openExternal: async (url) => {
      opened = url;
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), {
        status: 200,
      })) as typeof fetch,
    onComplete: complete,
    ...overrides,
  });
  controllers.push(controller);
  await expect(controller.start()).resolves.toEqual({ ok: true });
  const state = new URL(opened).searchParams.get('state');
  expect(state).toBeTruthy();
  return { controller, accept, complete, state: state! };
}

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
      openExternal: async (url) => {
        opened = url;
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), {
          status: 200,
        })) as typeof fetch,
      onComplete: complete,
    });
    controllers.push(controller);
    await expect(controller.start()).resolves.toEqual({ ok: true });
    const state = new URL(opened).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = await fetch(
      `http://127.0.0.1:1455/auth/callback?code=code-1&state=${encodeURIComponent(state!)}`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('signed in');
    expect(accept).toHaveBeenCalledWith('access', 'refresh');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('rejects a state mismatch with 400 and ends the flow', async () => {
    const { accept } = await startFlow();
    const callback = await request('http://127.0.0.1:1455/auth/callback?code=code-1&state=wrong');
    expect(callback.status).toBe(400);
    expect(callback.body).toContain('security check did not match');
    expect(accept).not.toHaveBeenCalled();
    // The flow ended (server closed), so a fresh sign-in can start.
    const { controller: next } = await startFlow();
    next.stop();
  });

  it('treats an oauth error param as a cancelled sign-in', async () => {
    const { accept, state } = await startFlow();
    const callback = await request(
      `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(400);
    expect(callback.body).toContain('cancelled');
    expect(accept).not.toHaveBeenCalled();
  });

  it('404s non-callback paths without ending the pending flow', async () => {
    const { accept, complete, state } = await startFlow();
    const stray = await request('http://127.0.0.1:1455/nope');
    expect(stray.status).toBe(404);
    expect(stray.body).toContain('sign-in page not found');
    // The real callback still lands afterwards.
    const callback = await request(
      `http://127.0.0.1:1455/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(200);
    expect(accept).toHaveBeenCalledWith('access', 'refresh');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('refuses a concurrent start() while a sign-in is pending', async () => {
    const { controller } = await startFlow();
    await expect(controller.start()).resolves.toEqual({
      ok: false,
      error: 'a chatgpt sign-in is already in progress',
    });
  });

  it('responds 500 and skips onComplete when the token exchange fails', async () => {
    const { accept, complete, state } = await startFlow({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    const callback = await request(
      `http://127.0.0.1:1455/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(500);
    expect(callback.body).toContain('could not finish sign-in');
    expect(accept).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('renderPage escapes HTML in the message', () => {
    const html = renderPage('<script>alert("x")</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
