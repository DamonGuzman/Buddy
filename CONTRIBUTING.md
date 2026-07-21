# Contributing to Buddy

Thanks for your interest in improving Buddy! This document covers how to get a
development environment running and what we expect from contributions.

## Before you start

- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. It is the single
  source of truth for scope, module ownership, the IPC and coordinate
  contracts, and project conventions. Changes that contradict it will be asked
  to update the doc or the approach.
- For anything beyond a small fix, please open an issue to discuss the change
  before investing significant time.

## Development setup

Runtime requirements: Node.js 22+, npm, and macOS 12+ or Windows 10 (build 19041+). Building on
macOS additionally requires Xcode command-line tools with the macOS 26 SDK because the universal
native bridge weak-links the macOS 26 Liquid Glass APIs while retaining a macOS 12 deployment
target.

```sh
npm install
npm run dev        # hot-reload dev app with a separate, persistent dev profile
npm test           # vitest unit tests
npm run build      # typecheck + production build
npm run test:browser # hidden-browser computer-use integration test
```

No API key is needed for development — a local mock speaks the Realtime
protocol subset:

```sh
npm run mock       # mock Realtime WS server (ws://127.0.0.1:8123)
CLICKY_MOCK_URL='ws://127.0.0.1:8123' CLICKY_DEBUG=1 npm run dev
```

See the [README](README.md#development) for the full development workflow,
including the eval harnesses.

## Hard rules

These are non-negotiable project invariants:

- TypeScript strict mode; typed IPC only via `src/shared/ipc.ts`;
  `contextIsolation` stays on.
- `src/shared/*` is a contract — do not change it unless your change
  explicitly requires it, and call it out in the PR description.
- Overlay windows must remain click-through and non-focusable — never steal
  focus from the user.
- Screen capture happens only on the hotkey or an explicit request, never
  continuously.
- Keep platform-specific code behind small seams.

## Pull requests

1. Fork and create a topic branch from `main`.
2. Keep changes focused; unrelated refactors belong in separate PRs.
3. Make sure the checks pass locally before pushing:

   ```sh
   npm run lint
   npm run format:check
   npm run typecheck
   npm test
   ```

4. Add or update tests for behavior you change. The test suite is the safety
   net for a highly stateful app — untested lifecycle changes are hard to
   accept.
5. Update the relevant doc in `docs/` when you change an architectural
   contract or user-visible behavior.

## Reporting bugs

Use the issue templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
