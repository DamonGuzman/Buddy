// probe-quota.mjs — exits 0 when the API accepts a minimal paid request,
// 1 on insufficient_quota / any failure. Used by the resume loop.
import { getApiKey } from './harness.mjs';
const r = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
});
if (r.ok) { console.log('quota OK'); process.exit(0); }
const j = await r.json().catch(() => ({}));
console.log(`quota check failed: ${r.status} ${j.error?.code ?? ''}`);
process.exit(1);
