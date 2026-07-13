# Buddy for Windows — Project Status

_Last updated: 2026-07-13. Single-source status for the MVP and follow-on work._
_Companion docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [EVAL](docs/EVAL.md) · [COORD-STUDY](docs/COORD-STUDY.md) · [AGENT-MODE](docs/AGENT-MODE.md)_

## TL;DR

Buddy is a Windows tray companion: hold **Ctrl + left-Alt**, talk, and Buddy sees the monitors,
answers in voice, and flies its pointer to the UI element it describes. Typed questions and
read-only background research agents use the user's ChatGPT plan; realtime voice uses an OpenAI API
key. The app is built, tested, packaged, upgraded in place, and running on this machine.

**Current source:** `main`, M18 Agent Mode + subscription text path + in-app ChatGPT sign-in.
**Installed build:** local M18 compatibility build at `%LOCALAPPDATA%\Programs\heyclicky\Buddy App.exe`.
SHA-256: `7614732DB20A59E79F698ACB83456E1CB8D08B4DF2FE3966C3580F7B0F9B6EEA`.
Settings migrated to schema v2; encrypted key, model, voice, captions, mic, and buddy position were
preserved.

## Done

### Core Windows product

- Electron/TypeScript/React tray app, global left-Alt hotkey, multi-display capture, protected
  overlays, realtime push-to-talk voice, streamed audio, barge-in, transcripts, encrypted API key,
  mock realtime server, debug harness, and packaged per-user install.
- DPI-safe screenshot-to-screen mapping across mixed DPI, negative origins, and portrait displays.
- Layered pointing: UIA element snap → model grounder → raw point. Live evaluated at 93% strict.
- Hardened lifecycle and error catalog: lock/sleep recovery, AltGr exclusion, renderer recovery,
  debug auth/Origin/Host checks, sandboxed renderers, silent-mic and DPAPI failure coverage.
- shadcn/ui panel, buddy hover/eye tracking, dwell click, and persisted drag repositioning.

### ChatGPT subscription paths

- Detects existing Codex CLI credentials and stores refreshed tokens with Electron safeStorage.
- System-browser + `127.0.0.1:1455` loopback PKCE sign-in for users without the Codex CLI.
- Subscription grounding uses `gpt-5.6-sol`; plan-limit failures are fail-closed and never silently
  spend the metered API key.
- Typed panel questions now run text-in/text-out through the ChatGPT subscription, with screenshots,
  multi-turn client-side history, streamed text, and the shared `point_at` dispatcher.
- Settings can explicitly prefer API-key grounding while agents remain subscription-billed.
- Live backend correction is implemented: `store:false`, no `previous_response_id`; history is
  replayed client-side. The backend's hosted `web_search` tool is supported and proven live.

### Agent mode — “buddy, agent”

- Realtime and typed personas register `spawn_agent` only while ChatGPT is connected.
- Main-process `AgentManager`: three concurrent runs, unlimited tool rounds, four-minute wall clock, backend
  timeouts/retry, cancellation, stop-all, app-quit cleanup, and persisted completed summaries.
- Read-only tools: hosted web search, SSRF-guarded/redirect-checked web fetch, private scratchpad,
  and re-read of the original handoff screenshot. Fetched content is delimited as untrusted.
- Voice handoff and return: immediate acknowledgement; live-session completion recap or next-turn
  recap, plus tray notification and an always-updated panel record.
- Agents panel: sign-in gate, running/unseen badge, live activity, elapsed time, stop controls,
  summaries, expandable findings, and source list. Dedicated visual/UX review completed.
- Deterministic mock backend and authenticated debug routes cover spawn/list/cancel without plan
  spend. A real `gpt-5.6-sol` run used hosted search, returned two official Node.js citations, and
  completed in about seven seconds.

### Verification and release

- `npm test`: **343 passed, 2 intentional live tests skipped**. Vitest files are serialized to
  eliminate local server/UIA daemon contention.
- `npm run build`: pass (node + web type checks and all Electron renderer/main bundles).
- `npm run dist`: pass (portable and one-click per-user NSIS artifacts).
- Electron debug E2E: spawn → tool loop → panel-safe record → persisted `agents.json`: pass.
- Live ChatGPT-plan research run: pass.
- Installed upgrade: installer exit 0, app relaunched, settings schema v2 read back successfully.

## External/manual boundary

### gpt-5.5 latency-floor and formal voice re-gates

The staged `eval/experiments/coord-study/audit-55.mjs` was retried on 2026-07-12. Its first
text-only enum probe received `You exceeded your current quota`; the harness stopped immediately,
before the measurement sweep. The formal five-turn voice latency and three-turn voice spot-check
also require platform API credit. Existing recorded evaluation remains green and the product model
decision is unchanged: API-key grounding uses `gpt-5.4-mini`; subscription grounding and agents use
`gpt-5.6-sol`.

## Future scope (not a Windows MVP blocker)

- Side-effecting agent tools (files, programs, calendar/email) require per-action confirmation and
  separate connector consent designs. Phase 1 intentionally remains read-only.
- In-flight agents do not resume after an app/OS crash; completed summaries do persist.
- macOS port.

## Known limitations

- Unsigned binaries may trigger SmartScreen when the installer is run manually.
- UI elements without accessible UIA names (canvas/emoji glyphs) fall back to model grounding/raw
  points.
- ChatGPT-plan usage shares the user's Codex quota window; agent and grounding failures stop rather
  than falling back to paid API usage.
