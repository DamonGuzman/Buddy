# Buddy for macOS and Windows

Buddy is a voice assistant that can *see your screen and point at
things*. It lives in the macOS menu bar or Windows system tray. **Hold `Control` + left
`Option` on macOS (`Ctrl` + left `Alt` on Windows) and talk** — while you hold,
Buddy screenshots your
monitors and streams your voice to a realtime speech-to-speech model (OpenAI Realtime API).
Release, and it answers out loud while a friendly blue buddy flies across a transparent overlay
to physically point at the buttons, fields, and menus it's describing. Pointing is grounded in
layers, never the model's raw pixel guess alone: on Windows the buddy first snaps onto the real
on-screen element matching what Buddy said via UI Automation, and when nothing there matches
(or on macOS) a fast vision-model grounding call
(gpt-5.4-mini, ~10px median) re-locates the target in the same screenshot. No chat window to manage:
ask "where do I turn on dark mode?" and Buddy tells you — and points. There's also a small
control panel (tray icon) with a live transcript and a typed-question fallback for when you
can't talk.

## Requirements

- macOS 12 or later, on Apple silicon or Intel; or Windows 10 build 19041 or later.
- A microphone.
- An OpenAI API key with access to the Realtime API (`gpt-realtime` models). Usage is billed to
  your own OpenAI account.

## Install

Choose the artifact for your computer. MVP builds are unsigned.

- **macOS** — `Buddy-<version>-<arch>.dmg` or `.zip`. Open the DMG and drag Buddy to
  Applications. The first launch may require Control-clicking Buddy and choosing **Open**.
- **Windows installer** — `Buddy Setup <version>.exe`: one-click per-user install.
- **Windows portable** — `Buddy <version>.exe`: single file, nothing to install. SmartScreen may
  warn; choose **More info → Run anyway**.

## First run

1. Launch Buddy. A tray icon appears, and the control panel opens by itself on first run.
2. Open settings (gear in the panel) and paste your OpenAI API key. It is encrypted on your
   machine before it's stored and never shown again.
3. On macOS, open **Settings → Permissions** in Buddy (or choose **Permissions…** from its
   menu-bar item). Each grant has its own **allow/fix** action and visible status. Buddy does not
   throw privacy prompts from its hidden startup window; it requests access only after you click a
   repair action or explicitly use the corresponding feature. Return from System Settings and
   Buddy re-checks automatically, including a live hotkey retry. Restart only when the card says
   the toggles are allowed but the running process is still blocked.
4. **Hold `Control` + left `Option` on macOS, or `Ctrl` + left `Alt` on Windows, and talk**
   ("what am I looking at?"). Keep holding while you
   speak; release to send. Buddy answers in voice and points at what it mentions.
5. For a hands-free back-and-forth, enable **full realtime mode** in settings. Press the hotkey
   once to activate and once more to deactivate; silence ends each turn automatically, and Buddy
   takes a fresh screenshot for every speech turn.
6. Somewhere quiet? Type a question in the panel instead — same pipeline, spoken answer +
   captions.

The hotkey is fixed at Control + the left Option/Alt key for the MVP. Right Option/Alt never
triggers it, avoiding AltGr on international Windows layouts.

**Model choice:** Buddy defaults to `gpt-realtime-2.1` — measurably the most accurate at
pointing (docs/EVAL.md §8). You can switch to `gpt-realtime-2.1-mini` in settings for
faster/cheaper replies, but expect noticeably less accurate pointing; screen reading and
conversation quality stay comparable.

## Privacy model

- **Capture only on an explicit action**: hotkey press/hold, full-realtime activation, or a typed
  question. Full realtime captures once at activation; it does not continuously watch the screen.
- Capture is **always signposted**: a visible indicator shows whenever Buddy is looking/listening.
- Your API key is stored **encrypted locally** (macOS Keychain or Windows DPAPI through Electron
  `safeStorage`) and
  never leaves the main process.
- No servers of ours: audio and screenshots go **directly from your machine to OpenAI**, and
  nowhere else. Local settings and session diagnostics remain in the platform's application-data
  folder until you delete them.

## Live smoke test (with your key)

After first-run setup, verify the whole loop end to end:

1. Open a busy app (a browser works). Hold the platform hotkey, ask *"point at the address bar"*,
   release → spoken answer + the buddy flies to the address bar.
2. Ask *"show me two things I could click here"* → two pointer flights in sequence.
3. Start a long answer, then press the hotkey mid-speech → playback stops instantly (barge-in)
   and Buddy listens to the new question.
4. Type a question in the panel → same answer flow, with captions if enabled.
5. Multi-monitor: ask about something on your other display → the buddy shows up there.

## Development

```sh
npm install
npm run dev        # hot reload with a separate, persistent development profile
npm run build      # typecheck + production build
npm test           # vitest unit tests (coords, protocol, hotkey FSM, settings, playback, ...)
npm run dist       # package for the current OS (DMG+ZIP or NSIS+portable)
npm run dist:mac   # explicitly package macOS DMG + ZIP
npm run dist:win   # explicitly package Windows NSIS + portable
```

`npm run dev` is the everyday development version; no installer rebuild is needed. Renderer edits
hot-reload in place, while main-process and preload edits automatically restart the development
app. It uses a separate `Buddy Dev` application-data profile so an installed Buddy does not block it through Electron's
single-instance lock, and it keeps the panel visible while you work. The development profile has
its own settings, but automatically imports `OPENAI_API_KEY` from the local user environment when
available. Electron encrypts it into the dev profile using Keychain/DPAPI, and
the plaintext is then removed from the app process. Quit the installed Buddy from its tray icon
before testing the hotkey, otherwise both running copies can receive it. On Windows, the same
command also starts the optional iPhone audio bridge, waits for it to become healthy, and connects
the development app to it; the printed setup URL is the page to open on the phone. The bridge stays
up across Electron restarts and exits with the dev command. macOS uses the Mac's microphone
directly. Use `npm run dev:raw` only when you deliberately want Electron's default profile behavior
without the managed development profile or phone bridge.

No API key needed for development — a local mock speaks the Realtime protocol subset:

```sh
npm run mock       # mock Realtime WS server (ws://127.0.0.1:8123)
# then run the app against it, with the local debug HTTP harness enabled:
CLICKY_MOCK_URL=ws://127.0.0.1:8123 CLICKY_DEBUG=1 npm run dev
```

`CLICKY_DEBUG=1` starts a token-authenticated local HTTP server (127.0.0.1:8199) that can
simulate hotkey press/release, inject text turns, and dump state/timings/played-audio — QA and
the evals drive the real pipeline through it.

Evals (mock by default, `--live` with a real key):

```sh
npm run eval:tts    # one-time: generate eval utterance WAVs (SAPI)
npm run eval:voice  # voice round-trip: audio in/out proof, latency, barge-in, guard rails
npm run eval        # pointing accuracy across kiosk scenes (calibration must hit)
```

Read `docs/ARCHITECTURE.md` first (scope, module ownership, IPC/coordinate contracts) and
`docs/EVAL.md` for the eval harness and current measured numbers.

## Known MVP limitations

- **Background work is read-only** — say "Buddy, agent ..." to delegate research; agents cannot
  modify files, send messages, make purchases, or control other applications.
- **Fixed hotkey** (Control + left Option/Alt) — not remappable yet.
- **Single voice pipeline** — mic capture and playback live in the (hidden) panel renderer; if
  that renderer is killed, voice drops until it auto-recovers.
- **Unsigned Windows binaries** — expect a Windows SmartScreen warning.
- **macOS distribution builds require stable signing** — `npm run dist` fails instead of silently
  producing a build that will invalidate privacy grants. Configure an Apple Development or
  Developer ID Application identity through `CSC_NAME` or `CSC_LINK`. Disposable local QA can set
  `BUDDY_ALLOW_ADHOC=1`, with the explicit tradeoff that every replacement needs fresh grants.
- **Ad-hoc macOS rebuilds need fresh privacy grants** — replacing an ad-hoc-signed Buddy changes
  its TCC identity. Buddy's Permissions card detects the stale grant, links each affected pane,
  offers a confirmed Buddy-only privacy reset, reveals the exact current app for manual
  remove/re-add, re-checks on return, and offers live retry plus restart. Stable signing avoids
  this churn for release builds.
- **macOS grounding fallback** uses the vision grounding layer; Windows additionally uses UIA.
- One realtime session at a time; no wake word, no integrations yet.
