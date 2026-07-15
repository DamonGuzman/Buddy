# Buddy for macOS and Windows — MVP Architecture & Scope

> The single source of truth for this MVP. All implementation agents read this first.
> Product research: see `docs/RESEARCH.md` (copied from the original teardown).

## 1. Product in one paragraph

A macOS menu-bar / Windows tray app. By default you **hold Control+left Option on macOS or
Ctrl+left Alt on Windows and talk**; an opt-in full realtime
mode turns the same hotkey into start/stop for an open-mic conversation. It screenshots your monitors,
streams your voice + the screenshots to a realtime speech-to-speech model (OpenAI `gpt-realtime` family), speaks
the answer back, and **flies an animated "buddy" pointer** (a friendly blue triangle) across a
transparent overlay to physically point at the UI element it's describing. No chat window. Warm,
lowercase, mentor-over-your-shoulder personality. Capture happens **only on an explicit hotkey or
typed action** and is always signposted by a visible indicator.

## 2. MVP scope

**In:**

- Hold-to-talk global hotkey (Control + left Option/Alt, both held; release = send). Only the left
  Option/Alt participates; right Alt remains available as AltGr on international Windows layouts.
- Opt-in full realtime mode: press the hotkey once to connect and keep the mic streaming with
  server VAD; each detected speech turn gets a fresh multi-monitor capture before its response.
  Press the hotkey again to stop. Lock/suspend always stops it.
- Multi-monitor screenshot capture on hotkey press (resized ≤2048px longest edge, JPEG ~80%;
  raised from 1280 in M8.6 for pointing accuracy — see docs/EVAL.md §8).
- OpenAI Realtime API session over **WebSocket** (PCM16 audio append; manual commit for push-to-talk,
  server VAD with automatic audio commit/interruption and client-created responses in full realtime
  mode so per-turn screenshots can be attached first). Audio streams as it arrives.
- `point_at` **tool call** drives the pointer (no regex tag parsing).
- Opt-in computer use: the realtime voice model has only a `use_computer` delegation tool.
  Executable click/type/key tools exist exclusively in a separate `gpt-5.6-sol` Responses loop
  over the user's ChatGPT subscription with `service_tier: priority` (fast mode). Sol inspects a
  fresh explicit screenshot after every single action; the realtime model never receives direct
  mouse or keyboard access.
- Per-monitor transparent click-through always-on-top overlay: buddy triangle, quadratic-bezier
  arc animation to targets, optional caption bubble (the spoken text), listening/thinking indicator.
- Tray icon + small control panel window: status, live transcript, **text-input fallback** (typed
  question → same pipeline, answer as caption + voice), settings.
- Settings: API key (encrypted via `safeStorage`), model (`gpt-realtime-2.1-mini` default /
  `gpt-realtime-2.1`), voice, hotkey display (fixed for MVP), captions on/off.
- Persona system prompt: lowercase, warm, brief, "written for the ear", never ends on a dead-end —
  always plants a seed for something more ambitious to try next. Calls `point_at` whenever it
  references something on screen.
- **Mock Realtime server** (local WS, speaks the same protocol subset) + **debug harness** for QA.

**Out (stub or defer):**

- Agent mode ("Buddy, agent") — main-process, read-only research agents with hosted web search,
  guarded web fetch, persisted panel results, cancellation, and voice handoff/return.
- Cloudflare Worker / ephemeral-token proxy (MVP is local-key, single user).
- Integrations (Notion/Gmail/Calendar/Linear), wake word, ElevenLabs, auto-update, installer polish.

## 3. Stack

- **Electron + TypeScript + electron-vite** (main / preload / renderer). React in renderers.
- **uiohook-napi** behind a platform seam for global keydown/keyup (Electron `globalShortcut` has
  no keyup, so it cannot implement hold-to-talk).
- Audio: renderer `getUserMedia` → `AudioWorklet` → PCM16 (24kHz mono) chunks → main → WS.
  Playback: WS audio deltas → renderer `AudioWorklet` queue. Barge-in not required for MVP
  (push-to-talk model).
- Screenshots: Electron `desktopCapturer` per display; resize via canvas in a hidden worker window
  or `sharp`-free approach (nativeImage resize is fine).
- No backend. Everything local.

## 4. Process & window model

- **Main process** owns: tray, window lifecycle, hotkey hook, screenshot capture, settings store,
  the **RealtimeSession** (WS client), tool-call dispatch, debug server.
- **Overlay renderer** (one `BrowserWindow` per display): `transparent: true`, `frame: false`,
  always on top at a platform-safe level, `setIgnoreMouseEvents(true)`,
  `skipTaskbar`, full display bounds, visible on all workspaces. Never use the `screen-saver` level
  on Windows: it sits above the taskbar and a full-display overlay can trigger fullscreen shell
  behavior. Before first show, the Windows seam marks each HWND `NonRudeHWND` so Explorer does not
  classify the full-display transparent overlay as a fullscreen app and demote the taskbar; if that
  marker fails, the overlay drops always-on-top rather than breaking the taskbar. Draws buddy +
  caption + indicator. Never focusable.
- **Settings/audio-host renderer** (M21 — the chat panel is GONE): the former panel window
  survives as a hidden audio host (mic capture + voice playback AudioWorklets live in its
  renderer, pre-created at app-ready, unthrottled) whose only visible face is a settings-only
  view opened from the tray's Settings item (plus first-run / actionable-error showOnce).
  Transcript, composer, and agents view are deleted — the whisper composer, caption bubbles,
  and overlay helper sprites carry those jobs. Tray click now toggles the whisper; a second
  app launch and overlay agent-clicks summon the whisper too. Internal `panel:*` channel and
  file names remain for wire/history stability and now denote this window.
- **Whisper renderer** (M20): ~340×244 transparent frameless composer anchored beside the buddy's
  rest spot — the text channel for can't-talk environments. Summoned by a hotkey TAP (release
  within `TAP_MAX_MS` = the conversation's `MIN_HOLD_MS`, so a tap never commits a voice turn) or
  by clicking the buddy (which no longer opens the panel). Full realtime mode ignores taps — the
  press toggles the open-mic session there, and the buddy click remains the whisper's summon.
  It is the ONE window allowed to steal focus (`app.focus({steal: true})`, explicitly summoned),
  hides on blur (with a short post-show grace for the Windows foreground fight) / esc / re-tap.
  Main mirrors `panel:transcript` + `panel:assistant-state` to it at the conversation's panel
  port (index.ts), so the conversation package stays whisper-unaware. Typed turns pair with the
  `voiceMuted` setting (quiet mode): model audio deltas are not played and captions are forced.
- IPC is **typed**: all channels + payload types live in `src/shared/ipc.ts`. Renderers get a
  narrow `window.clicky` API from `preload`. No `remote`, contextIsolation on everywhere.

## 5. Module map (ownership boundaries for agents)

```
src/
  shared/            types, ipc contract, settings schema, constants  (integration-owned)
  main/
    index.ts         app bootstrap, wiring only
    tray.ts          tray icon + menu
    windows/         overlay + panel + whisper window management (per-display lifecycle,
                     display hotplug; whisper.ts = M20 floating composer)
    hotkey.ts        uiohook hold-to-talk state machine (down→capture+listen, up→commit;
                     M20: release within TAP_MAX_MS additionally emits 'tap' → whisper)
    capture.ts       multi-display screenshot pipeline (capture, resize, label, filter own windows)
    coords.ts        screenshot px → display DIP coord mapping (pure functions, unit-tested)
    grounding/       Native accessibility grounding: Windows UIA daemon and macOS AX provider,
                     shared timeboxing and pure label scoring
    realtime/
      session.ts     WS session: connect, session.update, audio append/commit, image input,
                     response streaming, tool-call events, reconnect
      protocol.ts    typed subset of OpenAI Realtime events
      mockable.ts    URL override (CLICKY_MOCK_URL) so the same client talks to the mock
    persona.ts       system prompt + tool definitions (point_at)
    settings.ts      JSON store in userData, safeStorage-encrypted API key
    debug-server.ts  CLICKY_DEBUG=1 → 127.0.0.1:8199 HTTP: simulate hotkey, inject text turn,
                     read state, trigger pointer, dump last capture metadata
  renderer/
    overlay/         buddy canvas/DOM, bezier animation, caption bubble, indicators,
                     agent helper sprites + hover card (M19, docs/AGENT-MODE.md §5.5)
    panel/           M21: settings-only React app + the hidden audio engines
                     (the chat panel UI — transcript/composer/agents — is deleted)
    whisper/         M20 floating composer (reply stack + input + quiet-mode toggle)
  preload/           contextBridge APIs for each renderer
tools/
  mock-realtime/     standalone Node WS server speaking the Realtime protocol subset; scripted
                     scenarios (answer+point, multi-point, tone-audio output, agent-mode stub)
tests/               vitest unit tests (coords, protocol framing, settings, hotkey FSM)
```

## 6. Coordinate contract (the hard part — get this exact)

- Each capture produces, per display: `{ screenIndex, displayId, imageW, imageH, displayBounds
(DIP), scaleFactor }`. Images are labeled `screen0..N` in the prompt, with the cursor's display
  flagged as active.
- The model is told image dimensions and must call `point_at` with **pixel coords in that
  screenshot's space** plus the screen index.
- Client mapping: screenshot px → (÷ resize ratio) → physical display px → (÷ scaleFactor) →
  display-local DIP → (+ displayBounds origin) → global DIP → overlay-window-local coords.
- All pure functions in `coords.ts` with unit tests covering: 100%/150%/200% DPI, mixed-DPI dual
  monitor, negative-origin (left-of-primary) monitors.

## 6b. Layered grounding (M9 + M10)

The live evals (docs/EVAL.md §7-§8) proved the model names the right element essentially every
time but its raw coordinates drift scene-dependently. `point_at` is therefore GROUNDED before the
buddy flies. On Windows, `src/main/grounding/` keeps a persistent PowerShell UIA daemon
(`snapper.ps1`, embedded
at build time, spawned lazily, restarted on crash, killed on quit) that resolves the top-level
window under the model's point via Win32 `WindowFromPoint` (mouse hit-test semantics — skips
Buddy's own click-through overlays; the daemon makes itself Per-Monitor-V2 DPI-aware so user32
and UIA agree on physical px) and enumerates nearby named UIA elements (rect-pruned DFS,
CacheRequest-batched, node/time budgets). Selection is pure TS (`scoring.ts`, unit-tested):
normalize the spoken label and element Names, fuzzy token similarity with a small proximity
tie-break, threshold 0.55. The mapped point (§6) is converted DIP→physical
(`screen.dipToScreenPoint`), snapped to the matched element's center, converted back, and
dispatched; on no-match / 600ms timebox / daemon trouble the raw model point is used unchanged —
snapping is never worse than no snapping. On macOS the same contract is backed by Accessibility
(AX) through the platform grounder. The label chip keeps the MODEL's words. `CLICKY_NO_SNAP=1`
disables it (eval A/B); `POST /grounding/query` drives the snapper directly (debug server).
Attribution (raw vs snapped point, score, name, ms) rides on `PointerCommand.snap` and
`TurnTimings.tPointerDispatched`/`snapMs` for the eval harness.

**M10 — REST grounding fallback: native accessibility snap → REST ground → raw point.** The coordinate study
(docs/COORD-STUDY.md §8-§9) measured that coordinate weakness is realtime-family-specific:
`gpt-5.4-mini` at reasoning effort `low` over plain REST grounds the same screenshots at ~10px
median / 93% in-element / ~1.3s p50 — where the realtime model does ~80-100px. So when the UIA
snap finds no confident match (element with no UIA Name, label/name token mismatch, timeout),
`src/main/grounding/rest-grounder.ts` re-grounds the model's own spoken label against the SAME
screenshot JPEG the realtime model saw (the turn's `CaptureResult` is closure-retained by the
pointer dispatch, so this holds even after turn settle releases `turnCaptures`), replicating the
study's winning protocol: `POST /v1/responses`, bare image as a data URI (no overlays,
no gridlines), strict-JSON **pixel** coordinates of the provided image (the study showed
normalized 0-1000 output actively hurts new-gen models), 2.5s abort timeout. The result is a
point in screenshot pixel space, mapped like a model point (§6 `mapModelPoint`) and flown; on
null (no key / mock mode / timeout / HTTP or parse error / out-of-bounds) the raw model point is
used — the REST layer is never worse than today. The API key comes from the same settings source
as the realtime session (decrypted in main, never logged); one call max in flight; a superseding
turn / barge-in drops the pending pointer via the `turnToken` check, and the tool output has
already gone back so the model's spoken answer is never gated on grounding.
`CLICKY_NO_REST_GROUND=1` disables the REST layer (as `CLICKY_NO_SNAP=1` disables the UIA
layer); attribution rides on `PointerCommand.groundingSource` (`'uia' | 'ax' | 'rest' | 'raw'`) plus
`restUsed`/`restMs`, surfaced through `DebugState.lastPointer`. Headless validation of the
production code path: docs/EVAL.md §10.

## 7. Realtime protocol subset (v1 GA WS API)

- `session.update` (instructions, voice, tools, modalities, in/out audio format `pcm16`):
  `turn_detection: null` for push-to-talk, or `server_vad` with automatic audio commit/interruption
  and `create_response: false` for full realtime mode.
- Turn: `input_audio_buffer.append`* → `input_audio_buffer.commit` +
  `conversation.item.create` (screenshots as `input_image` content parts) → `response.create`.
- Text fallback: `conversation.item.create` (text + images) → `response.create`.
- Inbound: `response.output_audio.delta`, `response.output_audio_transcript.delta`,
  `response.function_call_arguments.done` (→ dispatch `point_at`, then send
  `conversation.item.create` function_call_output + continue), `response.done`, `error`.
- Reconnect with backoff; session is created lazily on first use and kept warm ~5min.

## 7b. Error catalog (M11)

Every user-reachable failure is classified into `src/main/errors.ts` — a pure catalog
(kind → lowercase Buddy copy: what happened + what to do) + `classifyError()` (server error
codes, HTTP-rejected WS upgrades, network errno strings, handshake timeouts). Consumers:
`conversation.failTurn`, the conversation's session `error` listener (mid-session events are
no longer a wordless red flash; mid-hold connect failures are deferred to commit resolution),
and boot wiring in `index.ts`. Kinds cover keys (missing / rejected / DPAPI-unreadable /
quota), server trouble (rate limit / model access / 5xx / interrupted / incomplete), devices
(mic via the renderer's `audio:capture-error` report + zero-chunk holds; speakers force
captions on while playback is down), and local failures (capture-less turns also inject a
"you cannot see the screen" context part; 30s hold watchdog; corrupt-settings reset; dead
keyboard hook; panel-renderer death → tray balloon). Unclassified errors keep
`something went wrong: <detail>` and still reach the transcript. Actionable kinds auto-show
the panel at most ONCE PER KIND per run (`windows/panel.ts` `showPanelOnce(reason)`; first-run
discoverability has its own budget). Boot order matters: the tray and the hotkey `error`
listener are created BEFORE `hotkey.start()` (an unlistened EventEmitter `error` used to abort
boot). Last resort: `uncaughtException`/`unhandledRejection` log to `<userData>/clicky.log`
and keep the tray app alive (verify with `CLICKY_TEST_THROW=exception|rejection`). Hostile-
endpoint testing: `tools/mock-realtime/reject-server.js` (HTTP-status upgrade rejections,
pre-settle quota errors); mock scenarios cover rate-limit / server-error / incomplete / agent-
mode. Runtime flags (`hookAlive`, CLICKY_* dev flags) reach the panel via `panel:runtime`.

## 7c. Local session history

Every app run is recorded under `<userData>/sessions/YYYY-MM-DD/<timestamp>_<session-id>/` for
debugging. `events.jsonl` is an append-only, sequenced journal, so completed records survive an
abrupt exit; `session.json` is an atomically replaced manifest whose `active` status identifies an
uncleanly-ended run. The journal includes renderer-safe settings, assistant/realtime state,
transcript upserts, errors, agent snapshots, tool calls, pointer attribution, response usage,
playback statistics, and complete turn timings. Each explicit turn also retains its JPEG captures
(with SHA-256 + `CaptureMeta`) and lossless input/output PCM sidecars (24 kHz, mono, signed 16-bit
little-endian). No continuous capture is added: only the screenshots/audio already collected for an
explicit Buddy session are persisted. API keys, authorization values, cookies, passwords, tokens,
and credential-shaped strings are defensively redacted. Persistence is fail-soft and must never
take down or stall shutdown of the tray app.

## 8. QA & verification plan

- Unit: vitest on coords/protocol/settings/hotkey FSM.
- E2E (no API key needed): launch app with `CLICKY_DEBUG=1 CLICKY_MOCK_URL=ws://127.0.0.1:8123`,
  drive via debug HTTP (simulate hotkey press/release, inject text), assert state via debug
  endpoints, and verify visuals via platform screenshots (ScreenCaptureKit on macOS or PowerShell
  System.Drawing on Windows).
- Mock scenarios must exercise: spoken answer + single point, multi-monitor point, caption text,
  tool-call round-trip, error recovery.
- Live smoke test with a real OpenAI key = final user step (documented in README).

## 9. Conventions

- TypeScript strict. No `any` at module boundaries. Prettier defaults, 100-col.
- Every module owned by one agent per wave; **shared files (`src/shared/*`) change only via the
  integration/orchestrator-approved edits**.
- Commit per milestone with clear messages.
- `npm run dev` (electron-vite dev), `npm run build`, `npm test`, `npm run mock` (mock server),
  `npm run dist` (electron-builder, DMG + ZIP on macOS or portable + NSIS on Windows).
