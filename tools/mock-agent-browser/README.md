# Mock agent browser fixtures

These localhost-only pages back the deterministic computer-use stories in
`src/main/agents/mock-backend.ts`. They do not call external services or mutate
anything outside the in-memory fixture page.

```sh
node tools/mock-agent-browser/server.mjs
```

The default origin is `http://127.0.0.1:8237`. Set
`BUDDY_MOCK_AGENT_FIXTURE_PORT=0` when importing/running it from an isolated test.
The browser profile's destination guard must explicitly allow the fixture
origin; the production SSRF guard correctly rejects loopback by default.
