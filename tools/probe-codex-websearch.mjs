/**
 * Probe: does the ChatGPT-subscription Codex backend expose a hosted
 * `web_search` tool, and does `store:true` + `previous_response_id`
 * continuation work?  (AGENT-MODE.md open question #1.)
 *
 * Standalone — NOT wired into the app. Run:  node tools/probe-codex-websearch.mjs
 * Spends the user's ChatGPT-plan quota: at most ~4 live calls, 60s timeout each.
 *
 * Transport copied verbatim from src/main/grounding/rest-grounder.ts
 * (requestCodex) + auth mirrored from src/main/auth/codex-auth.ts.
 *
 * RESULTS (probed live 2026-07-12, Pro plan, gpt-5.6-sol):
 * - tools:[{type:"web_search"}]  -> SUPPORTED. Streams
 *   response.web_search_call.{in_progress,searching,completed} +
 *   response.output_text.annotation.added (url citation), answered correctly.
 * - store:true                   -> 400 {"detail":"Store must be set to false"}
 * - previous_response_id         -> 400 {"detail":"Unsupported parameter: previous_response_id"}
 *   => NO server-side continuation on this backend; an agent loop must re-send
 *   the full transcript (client-side history) each turn, store:false always.
 * - QUIRK: response.completed's response.output was EMPTY ([]) even though
 *   text+web_search_call items streamed — accumulate deltas; don't rely on the
 *   final aggregate. usage IS present on response.completed.
 * - Quota telemetry: x-codex-primary-used-percent etc. on the 200 response
 *   (absent on 400s); also x-codex-plan-type, x-codex-credits-*.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODEL = 'gpt-5.6-sol';
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_SCOPE = 'openid profile email offline_access';
const TIMEOUT_MS = 60_000;

let liveCalls = 0;
const MAX_LIVE_CALLS = 4;

// ---------------------------------------------------------------------------
// Auth (mirrors codex-auth.ts; read-only w.r.t. ~/.codex/auth.json)
// ---------------------------------------------------------------------------

function b64urlToJson(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

async function getAuth() {
  const file = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
  const tokens = file.tokens ?? {};
  let accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const payload = b64urlToJson(accessToken.split('.')[1]);
  const claim = payload['https://api.openai.com/auth'] ?? {};
  let accountId = tokens.account_id || claim.chatgpt_account_id || '';
  const expMs = payload.exp * 1000;

  if (expMs <= Date.now() + 5 * 60_000) {
    console.log('[auth] access token near/at expiry — refreshing (in-memory only)...');
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: OAUTH_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`refresh failed: http ${res.status}`);
    const j = await res.json();
    accessToken = j.access_token;
    const p2 = b64urlToJson(accessToken.split('.')[1]);
    const c2 = p2['https://api.openai.com/auth'] ?? {};
    if (c2.chatgpt_account_id) accountId = c2.chatgpt_account_id;
    console.log('[auth] refreshed OK (NOT written back to auth.json)');
  } else {
    console.log(`[auth] file token valid until ${new Date(expMs).toISOString()}, plan=${claim.chatgpt_plan_type ?? '?'}`);
  }
  return { accessToken, accountId };
}

// ---------------------------------------------------------------------------
// One POST to the Codex responses endpoint (SSE), fully instrumented.
// ---------------------------------------------------------------------------

function interestingHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (/^(x-codex|x-ratelimit|ratelimit|retry-after|x-request-id|openai)/i.test(k)) out[k] = v;
  }
  return out;
}

async function codexPost(auth, label, body) {
  if (liveCalls >= MAX_LIVE_CALLS) throw new Error('live-call budget exhausted');
  liveCalls++;
  console.log(`\n===== ${label} (live call ${liveCalls}/${MAX_LIVE_CALLS}) =====`);
  console.log('[req body]', JSON.stringify({ ...body, input: '<omitted for log>' }));
  const t0 = Date.now();
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-Id': auth.accountId,
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: ORIGINATOR,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  console.log(`[http] ${res.status} ${res.statusText} in ${Date.now() - t0}ms`);
  console.log('[headers]', JSON.stringify(interestingHeaders(res.headers), null, 2));

  const raw = await res.text();
  if (!res.ok) {
    console.log('[error body verbatim]', raw.slice(0, 3000));
    return { ok: false, status: res.status, raw };
  }

  // Parse SSE: record every event type seen; keep response.completed payload.
  const eventTypes = new Map();
  let completed = null;
  let failed = null;
  let outputText = '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trimStart();
    if (!t.startsWith('data:')) continue;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let evt;
    try { evt = JSON.parse(data); } catch { continue; }
    const type = evt.type ?? '?';
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    if (type === 'response.output_text.delta' && typeof evt.delta === 'string') outputText += evt.delta;
    if (type === 'response.completed') completed = evt.response;
    if (type === 'response.failed' || type === 'error') failed = evt;
  }
  console.log('[sse event types]', JSON.stringify(Object.fromEntries(eventTypes)));
  if (failed) console.log('[failed/error event verbatim]', JSON.stringify(failed).slice(0, 3000));
  if (completed) {
    const items = (completed.output ?? []).map((it) => ({
      type: it.type,
      ...(it.type === 'web_search_call' ? { status: it.status, action: it.action } : {}),
    }));
    console.log('[response.id]', completed.id);
    console.log('[response.store-related fields]', JSON.stringify({
      store: completed.store, previous_response_id: completed.previous_response_id,
      status: completed.status, model: completed.model,
    }));
    console.log('[output items]', JSON.stringify(items, null, 2).slice(0, 2000));
    console.log('[usage]', JSON.stringify(completed.usage));
  }
  console.log('[final text]', (outputText || '(none)').slice(0, 500));
  return { ok: true, status: res.status, completed, failed, outputText, raw };
}

// ---------------------------------------------------------------------------
// The probe sequence
// ---------------------------------------------------------------------------

const auth = await getAuth();

const baseBody = {
  model: MODEL,
  instructions: 'you are a research assistant',
  stream: true,
  // Backend REQUIRES store:false (400 "Store must be set to false" otherwise).
  store: false,
  reasoning: { effort: 'low' },
};
const q1Input = [{
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'in one sentence, what is the latest stable Node.js LTS version? use web search' }],
}];

// POST 1: hosted web_search, store:true.
let r1 = await codexPost(auth, 'POST 1: tools=[web_search], store:true', {
  ...baseBody,
  input: q1Input,
  tools: [{ type: 'web_search' }],
});

// Fallback A: if the tool type itself was rejected, try web_search_preview.
const rejectedToolType = (r) =>
  (!r.ok && /web_search|tool/i.test(r.raw)) ||
  (r.ok && r.failed && /web_search|tool/i.test(JSON.stringify(r.failed)));
// Fallback B: if store:true was rejected, retry web_search with store:false.
const rejectedStore = (r) =>
  (!r.ok && /store/i.test(r.raw)) ||
  (r.ok && r.failed && /store/i.test(JSON.stringify(r.failed)));

let usedToolType = 'web_search';
if (!r1.ok || r1.failed) {
  if (rejectedStore(r1) && !rejectedToolType(r1)) {
    r1 = await codexPost(auth, 'POST 1b: tools=[web_search], store:false (store rejected)', {
      ...baseBody, store: false, input: q1Input, tools: [{ type: 'web_search' }],
    });
  } else {
    usedToolType = 'web_search_preview';
    r1 = await codexPost(auth, 'POST 1b: tools=[web_search_preview], store:true', {
      ...baseBody, input: q1Input, tools: [{ type: 'web_search_preview' }],
    });
  }
}

// POST 2: server-side continuation via previous_response_id (only if stored).
// KNOWN RESULT: 400 {"detail":"Unsupported parameter: previous_response_id"}.
if (r1.ok && r1.completed?.id) {
  const r2 = await codexPost(auth, `POST 2: previous_response_id=${r1.completed.id}`, {
    ...baseBody,
    previous_response_id: r1.completed.id,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'thanks — and in one sentence, when was it released?' }],
    }],
  });
  if (r2.ok && r2.completed) {
    console.log('\n[continuation verdict] answered without re-sending context:',
      /release|20\d\d|\bnov|\boct|\bapr/i.test(r2.outputText) ? 'LOOKS CONTEXTUAL' : 'CHECK TEXT ABOVE');
  }
} else {
  console.log('\n[continuation] skipped — POST 1 did not yield a stored response id');
}

console.log(`\nDone. Tool type that worked (if any): ${usedToolType}. Live calls used: ${liveCalls}`);
