# Buddy for macOS and Windows (MVP)

macOS menu-bar / Windows tray app: hold Control+left Option on macOS or Ctrl+left Alt on Windows, talk; it sees your screens, answers in voice, and flies an
animated pointer to what it's describing. Read `docs/ARCHITECTURE.md` before changing anything —
it defines scope, module ownership, the IPC/coordinate contracts, and conventions.

## Commands
- `npm run dev` — electron-vite dev mode
- `npm run build` — typecheck + production build
- `npm test` — vitest unit tests
- `npm run mock` — local mock Realtime WS server (tools/mock-realtime)
- `npm run eval` — pointing-accuracy eval (kiosk scenes; mock by default, `--live` for real API)
- `npm run eval:voice` — voice round-trip / latency / barge-in eval (see docs/EVAL.md)
- `npm run eval:tts` — generate eval utterance WAVs (SAPI, one-time)
- `npm run icon` — regenerate Windows/macOS app and tray icons (build/make-icon.mjs)
- `npm run dist` — package the current OS (macOS DMG+ZIP or Windows NSIS+portable, unsigned)

## Hard rules
- TypeScript strict; typed IPC only via `src/shared/ipc.ts`; contextIsolation stays on.
- `src/shared/*` is a contract: do not change it unless your task explicitly says so.
- Overlay windows must remain click-through and non-focusable — never steal focus from the user.
- Screen capture only on hotkey / explicit request, never continuous.
- Keep platform-specific code behind small seams.
