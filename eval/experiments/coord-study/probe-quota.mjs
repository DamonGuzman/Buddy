// probe-quota.mjs — exits 0 when the API accepts a minimal paid request,
// 1 on insufficient_quota / any failure. Used by the resume loop.
// NOTE: uses process.exitCode (not process.exit) — hard-exiting mid-fetch
// teardown trips a libuv assertion on Windows and corrupts the exit code.
import { getApiKey } from './harness.mjs';
try {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
    }),
  });
  if (r.ok) {
    await r.text().catch(() => {});
    console.log('quota OK');
    process.exitCode = 0;
  } else {
    const j = await r.json().catch(() => ({}));
    console.log(`quota check failed: ${r.status} ${j.error?.code ?? ''}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`quota check failed: ${err.message}`);
  process.exitCode = 1;
}
