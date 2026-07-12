# Clicky for Windows

Clicky is a voice assistant that can *see your screen and point at things*. It lives in your
system tray. **Hold `Ctrl` + left `Alt` and talk** — while you hold, Clicky screenshots your
monitors and streams your voice to a realtime speech-to-speech model (OpenAI Realtime API).
Release, and it answers out loud while a friendly blue buddy flies across a transparent overlay
to physically point at the buttons, fields, and menus it's describing. No chat window to manage:
ask "where do I turn on dark mode?" and Clicky tells you — and points. There's also a small
control panel (tray icon) with a live transcript and a typed-question fallback for when you
can't talk.

## Requirements

- Windows 10 version 2004 (build 19041) or later — Windows 11 works great.
- A microphone.
- An OpenAI API key with access to the Realtime API (`gpt-realtime` models). Usage is billed to
  your own OpenAI account.

## Install

Grab either artifact from a release (both are 64-bit, unsigned for this MVP — SmartScreen will
warn; choose "More info → Run anyway"):

- **Installer** — `Clicky Setup <version>.exe`: one-click per-user install, Start-menu entry.
- **Portable** — `Clicky <version>.exe`: single file, run from anywhere, nothing to install.

## First run

1. Launch Clicky. A tray icon appears, and the control panel opens by itself on first run.
2. Open settings (gear in the panel) and paste your OpenAI API key. It is encrypted on your
   machine before it's stored and never shown again.
3. **Hold `Ctrl` + left `Alt` and talk** ("what am I looking at?"). Keep holding while you
   speak; release to send. Clicky answers in voice and points at what it mentions.
4. Somewhere quiet? Type a question in the panel instead — same pipeline, spoken answer +
   captions.

The hotkey is fixed at `Ctrl` + **left** `Alt` for the MVP. The right `Alt` key (AltGr on
international layouts) never triggers it, so typing accented characters is safe.

## Privacy model

- **Capture only while you hold the hotkey** (or when you explicitly send a typed question).
  There is no continuous recording or screen-watching — ever.
- Capture is **always signposted**: a visible indicator shows whenever Clicky is looking/listening.
- Your API key is stored **encrypted locally** (Windows DPAPI via Electron `safeStorage`) and
  never leaves the main process.
- No servers of ours: audio and screenshots go **directly from your machine to OpenAI**, and
  nowhere else. Uninstalling removes the app; your data dir (`%APPDATA%/Clicky`) is kept unless
  you delete it.

## Live smoke test (with your key)

After first-run setup, verify the whole loop end to end:

1. Open a busy app (a browser works). Hold `Ctrl`+left `Alt`, ask *"point at the address bar"*,
   release → spoken answer + the buddy flies to the address bar.
2. Ask *"show me two things I could click here"* → two pointer flights in sequence.
3. Start a long answer, then press the hotkey mid-speech → playback stops instantly (barge-in)
   and Clicky listens to the new question.
4. Type a question in the panel → same answer flow, with captions if enabled.
5. Multi-monitor: ask about something on your other display → the buddy shows up there.

## Development

```powershell
npm install
npm run dev        # electron-vite dev mode
npm run build      # typecheck + production build
npm test           # vitest unit tests (coords, protocol, hotkey FSM, settings, playback, ...)
npm run dist       # package NSIS installer + portable exe (unsigned)
```

No API key needed for development — a local mock speaks the Realtime protocol subset:

```powershell
npm run mock       # mock Realtime WS server (ws://127.0.0.1:8123)
# then run the app against it, with the local debug HTTP harness enabled:
$env:CLICKY_MOCK_URL='ws://127.0.0.1:8123'; $env:CLICKY_DEBUG='1'; npm run dev
```

`CLICKY_DEBUG=1` starts a token-authenticated local HTTP server (127.0.0.1:8199) that can
simulate hotkey press/release, inject text turns, and dump state/timings/played-audio — QA and
the evals drive the real pipeline through it.

Evals (mock by default, `--live` with a real key):

```powershell
npm run eval:tts    # one-time: generate eval utterance WAVs (SAPI)
npm run eval:voice  # voice round-trip: audio in/out proof, latency, barge-in, guard rails
npm run eval        # pointing accuracy across kiosk scenes (calibration must hit)
```

Read `docs/ARCHITECTURE.md` first (scope, module ownership, IPC/coordinate contracts) and
`docs/EVAL.md` for the eval harness and current measured numbers.

## Known MVP limitations

- **Agent mode is a stub** — "Clicky, agent ..." gets a friendly "coming soon", it does not act.
- **Fixed hotkey** (`Ctrl` + left `Alt`) — not remappable yet.
- **Single voice pipeline** — mic capture and playback live in the (hidden) panel renderer; if
  that renderer is killed, voice drops until it auto-recovers.
- **Unsigned binaries** — expect the SmartScreen warning.
- **Windows only** for now; platform code is seamed for a macOS port later.
- One realtime session at a time; no wake word, no integrations yet.
