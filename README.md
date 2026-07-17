# Buddy for macOS and Windows

Buddy is a voice assistant that can _see your screen and point at
things_. It lives in the macOS menu bar or Windows system tray. **Hold `Control` + left `Option`
on macOS, or `Ctrl` + left `Alt` on Windows, and talk** — while you hold,
Buddy screenshots your
monitors and streams your voice to a realtime speech-to-speech model (OpenAI Realtime API).
Release, and it answers out loud while a friendly blue buddy flies across a transparent overlay
to physically point at the buttons, fields, and menus it's describing. Pointing is grounded in
layers, never the model's raw pixel guess alone: the buddy first snaps onto the real on-screen
element matching what Buddy said via the platform accessibility tree (AX/UIA), and when nothing
there matches (unnamed glyph buttons, canvas UI) a fast vision-model grounding call
(gpt-5.4-mini, ~10px median) re-locates the target in the same screenshot. No chat window to manage:
ask "where do I turn on dark mode?" and Buddy tells you — and points. There's also a compact
Settings window from the tray icon, plus a floating whisper composer for typed questions when
you can't talk.

## Requirements

- macOS 12 or later (Apple silicon or Intel), or Windows 10 build 19041 or later.
- A microphone.
- An OpenAI API key with access to the Realtime API (`gpt-realtime` models). Usage is billed to
  your own OpenAI account.
- A Firecrawl API key for helper-buddy web research. OpenAI remains the reasoning backend, but it
  does not receive or execute Buddy's web requests.

## Install

Choose the artifact for your computer. MVP builds are unsigned:

- **macOS** — `Buddy-<version>-<arch>.dmg` or `.zip`. Open the DMG and drag Buddy to Applications.
- **Windows installer** — `Buddy Setup <version>.exe`: one-click per-user install.
- **Windows portable** — `Buddy <version>.exe`: single file, nothing to install. SmartScreen may
  warn; choose **More info → Run anyway**.

## First run

1. Launch Buddy. A menu-bar/tray icon appears, and settings opens by itself on first run.
2. Open **Settings** from the menu-bar/tray icon and paste your OpenAI API key. It is encrypted on your
   machine before it's stored and never shown again.
3. Paste your Firecrawl key in **Settings → Firecrawl** to enable search, full-page scrape, map,
   crawl, batch scrape, and research for helper buddies.
4. On macOS, use **Settings → Permissions** to grant microphone, screen recording, accessibility,
   and input monitoring only when Buddy asks for each capability.
5. **Hold the platform hotkey and talk** ("what am I looking at?"). Keep holding while you
   speak; release to send. Buddy answers in voice and points at what it mentions.
6. For a hands-free back-and-forth, enable **full realtime mode** in settings. Press the hotkey
   once to activate and once more to deactivate; silence ends each turn automatically, and Buddy
   takes a fresh screenshot for every speech turn.
7. Somewhere quiet? Tap the hotkey to open the whisper composer and type instead — same pipeline.

The hotkey is fixed at Control plus the left Option/Alt key for the MVP. Right Option/Alt never
triggers it, avoiding AltGr on international Windows layouts.

**Model choice:** Buddy defaults to `gpt-realtime-2.1` — measurably the most accurate at
pointing (docs/EVAL.md §8). You can switch to `gpt-realtime-2.1-mini` in settings for
faster/cheaper replies, but expect noticeably less accurate pointing; screen reading and
conversation quality stay comparable.

## Privacy model

- **Capture only on an explicit action**: hotkey press/hold, full-realtime activation, or a typed
  question. Full realtime captures once at activation; it does not continuously watch the screen.
- Capture is **always signposted**: a visible indicator shows whenever Buddy is looking/listening.
- Your OpenAI and Firecrawl API keys are stored **encrypted locally** (macOS Keychain or Windows DPAPI via Electron
  `safeStorage`) and
  never leaves the main process.
- No servers of ours: audio and screenshots go **directly from your machine to OpenAI**. When a
  helper uses a web tool, only that tool's query, URL, and options go directly to Firecrawl; the
  Firecrawl key never goes to OpenAI. Uninstalling removes the app; the compatibility data dir (`%APPDATA%/heyclicky`)
  is kept unless
  you delete it.

## Live smoke test (with your key)

After first-run setup, verify the whole loop end to end:

1. Open a busy app (a browser works). Hold the platform hotkey, ask _"point at the address bar"_,
   release → spoken answer + the buddy flies to the address bar.
2. Ask _"show me two things I could click here"_ → two pointer flights in sequence.
3. Start a long answer, then press the hotkey mid-speech → playback stops instantly (barge-in)
   and Buddy listens to the new question.
4. Tap the hotkey and type a question in the whisper composer → same answer flow.
5. Multi-monitor: ask about something on your other display → the buddy shows up there.

## Development

```powershell
npm install
npm run dev        # hot reload with a separate, persistent development profile
npm run build      # typecheck + production build
npm test           # vitest unit tests (coords, protocol, hotkey FSM, settings, playback, ...)
npm run test:browser # Electron browser computer-use integration verification (no API key)
npm run dist       # package current OS (macOS DMG+ZIP or Windows NSIS+portable)
npm run dist:mac   # explicitly package macOS
npm run dist:win   # explicitly package Windows
```

`npm run dev` is the everyday development version; no installer rebuild is needed. Renderer edits
hot-reload in place, while main-process and preload edits automatically restart the development
app. It uses a separate `Buddy Dev` application-data profile so an installed Buddy does not block
it through Electron's
single-instance lock, and it keeps the panel visible while you work. The development profile has
its own settings, but automatically imports `OPENAI_API_KEY` from the local user environment when
available. Electron encrypts it into the dev profile using Keychain/DPAPI, and
the plaintext is then removed from the app process. Quit the installed Buddy from its tray icon
before testing the hotkey, otherwise both running copies can receive it. Plain `npm run dev` uses
the computer's microphone on every platform. The disposable bundled iPhone-audio QA bridge is
Windows-only and starts only when `CLICKY_PHONE_AUDIO_AUTOSTART=1` is set; an explicitly managed
bridge can instead be selected with `CLICKY_PHONE_AUDIO_URL=<url>`. Use `npm run dev:raw` only when
you deliberately want Electron's default profile behavior.

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

- **Computer use is deliberately bounded** — a helper can use Buddy's dedicated browser only
  when the foreground handoff grants browser access for that task. It cannot borrow the user's
  normal browser profile, type credentials, accept OAuth grants, upload/download files, or bypass
  the independent action reviewer and raise-hand approvals. Live-desktop mouse/keyboard use is a
  separate Settings opt-in and every proposed action requires a one-use human approval.
- **Buddy's browser is not a security sandbox** — it is a hardened, persistent Electron browser
  profile (`persist:buddy`) that the user explicitly enrolls into sites. Private-network blocking
  and renderer hardening are defense in depth, not an isolation boundary. Settings can sign out
  individual enrolled sites, revoke remembered action scopes, or clear the whole profile.
- **Fixed hotkey** (Control + left Option/Alt) — not remappable yet.
- **Single voice pipeline** — mic capture and playback live in the (hidden) panel renderer; if
  that renderer is killed, voice drops until it auto-recovers.
- **Unsigned Windows binaries** — expect the SmartScreen warning.
- **macOS distribution builds need signing credentials** for a trusted direct-distribution build.
- One realtime session at a time; no wake word, no integrations yet.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development
workflow and project invariants, and read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before
touching anything structural. Security issues go through [SECURITY.md](SECURITY.md), not the
public issue tracker.

## License

[MIT](LICENSE) © Fastyr, Inc.
