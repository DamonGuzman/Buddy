# Buddy — screen-aware voice assistance for macOS and Windows

Buddy is a cross-platform desktop voice assistant that can _see your screen and point at things_.
On macOS it can also delegate longer work to background helper buddies. It lives in the macOS menu
bar or Windows system tray. **Hold `Control` + left `Option` on macOS, or `Ctrl` + left `Alt` on
Windows, and talk** — while you hold, Buddy captures your monitors and streams your voice to a
realtime speech-to-speech model (OpenAI Realtime API).
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
- For opt-in computer use and, on macOS, helper buddies: a ChatGPT sign-in. A Firecrawl API key is
  additionally required for helper-buddy web-research tools. OpenAI remains the reasoning backend,
  but it does not receive or execute Buddy's Firecrawl requests.

## Platform support

The core app is implemented and packaged on both supported platforms:

| Capability                                                                    | macOS                                                         | Windows                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| Voice and typed turns, multi-monitor capture, overlays, and pointer animation | Yes                                                           | Yes                           |
| Native accessibility grounding                                                | AX                                                            | UI Automation                 |
| Opt-in live-desktop click and keyboard control                                | CoreGraphics/Accessibility input                              | Win32/PowerShell input daemon |
| Helper-buddy browser, approvals, memory, and web tools                        | Yes                                                           | Yes                           |
| Helper-buddy host shell and transactional filesystem workflow                 | Yes                                                           | Not yet                       |
| Helper buddy admission                                                        | Yes                                                           | Not yet                       |
| Notch-aware Live Bar and native Liquid Glass                                  | Live Bar on supported Mac displays; Liquid Glass on macOS 26+ | Not available                 |

Every helper buddy currently requires the host-shell/filesystem workspace at admission, so helper
buddy mode fails closed on Windows even though its browser and approval components are
cross-platform. The bundled phone-audio bridge is a separate Windows-only QA accessory; it is not
part of Buddy's normal microphone path and does not limit the macOS app.

## Install

Choose the artifact for your computer:

- **macOS** — `Buddy-<version>-<arch>.dmg` or `.zip`. Production releases must pass the Developer ID
  signing and notarization gate. Disposable local QA artifacts may be ad-hoc signed and require
  permissions to be granted again after replacement. Open the DMG and drag Buddy to Applications.
- **Windows installer** — `Buddy Setup <version>.exe`: one-click per-user install.
- **Windows portable** — `Buddy <version>.exe`: single file, nothing to install. SmartScreen may
  warn for the current unsigned builds; choose **More info → Run anyway**.

## First run

1. Launch Buddy. A menu-bar/tray icon appears, and settings opens by itself on first run.
2. Open **Settings** from the menu-bar/tray icon and paste your OpenAI API key. It is encrypted on your
   machine before it's stored and never shown again.
3. On macOS, paste your Firecrawl key in **Settings → Firecrawl** to enable search, full-page
   scrape, map, crawl, batch scrape, and research for helper buddies.
4. Use **Settings → ChatGPT** to connect the plan that powers opt-in computer use on both platforms
   and helper buddies on macOS.
5. On macOS, use **Settings → Permissions** to grant microphone, screen recording, accessibility,
   and input monitoring only when Buddy asks for each capability.
6. **Hold the platform hotkey and talk** ("what am I looking at?"). Keep holding while you
   speak; release to send. Buddy answers in voice and points at what it mentions.
7. For a hands-free back-and-forth, enable **full realtime mode** in settings. Press the hotkey
   once to activate and once more to deactivate; silence ends each turn automatically, and Buddy
   takes a fresh screenshot for every speech turn.
8. Somewhere quiet? Tap the hotkey to open the whisper composer and type instead — same pipeline.

The hotkey is currently fixed at Control plus the left Option/Alt key. Right Option/Alt never
triggers it, avoiding AltGr on international Windows layouts.

**Model choice:** Buddy defaults to `gpt-realtime-2.1` — measurably the most accurate at
pointing (docs/EVAL.md §8). You can switch to `gpt-realtime-2.1-mini` in settings for
faster/cheaper replies, but expect noticeably less accurate pointing; screen reading and
conversation quality stay comparable.

## Privacy model

- **Capture only on an explicit action**: hotkey press/hold, an active full-realtime conversation,
  or a typed question. Full realtime takes one fresh capture for each detected speech turn; it does
  not continuously watch or record the screen between turns.
- Capture is **always signposted**: a visible indicator shows whenever Buddy is looking/listening.
- Your OpenAI and Firecrawl API keys are stored **encrypted locally** (macOS Keychain or Windows DPAPI via Electron
  `safeStorage`) and
  never leave the main process.
- No Buddy relay server: audio and screenshots go **directly from your machine to OpenAI**. When a
  helper uses a web tool, only that tool's query, URL, and options go directly to Firecrawl; the
  Firecrawl key never goes to OpenAI. Uninstalling leaves local settings and history in Electron's
  `Buddy` application-data directory (`~/Library/Application Support/Buddy` on macOS or
  `%APPDATA%\Buddy` on Windows). Upgraded installations may continue using the legacy `heyclicky`
  directory when it contains the existing settings file.

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

```sh
npm install
npm run dev        # hot reload with a separate, persistent development profile
npm run build      # typecheck + production build
npm test           # vitest unit tests (coords, protocol, hotkey FSM, settings, playback, ...)
npm run test:browser # Electron browser computer-use integration verification (no API key)
npm run dist       # package current OS (macOS DMG+ZIP or Windows NSIS+portable)
npm run dist:mac   # explicitly package macOS
npm run dist:win   # explicitly package Windows
```

On macOS, building the universal native bridge requires Xcode command-line tools with the macOS 26
SDK even though the finished app runs on macOS 12+. `npm run dist` requires a stable Apple signing
identity by default; use `BUDDY_ALLOW_ADHOC=1 npm run dist` only for disposable local QA.

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

```sh
npm run mock       # mock Realtime WS server (ws://127.0.0.1:8123)
# in another shell, run the app against it with the debug HTTP harness enabled:
CLICKY_MOCK_URL='ws://127.0.0.1:8123' CLICKY_DEBUG=1 npm run dev
```

In PowerShell, set the same variables with
`$env:CLICKY_MOCK_URL='ws://127.0.0.1:8123'; $env:CLICKY_DEBUG='1'; npm run dev`.

`CLICKY_DEBUG=1` starts a token-authenticated local HTTP server (127.0.0.1:8199) that can
simulate hotkey press/release, inject text turns, and dump state/timings/played-audio — QA and
the evals drive the real pipeline through it.

Evals (mock by default, `--live` with a real key):

```sh
npm run eval:tts    # Windows/SAPI only: generate eval utterance WAVs once
npm run eval:voice  # voice round-trip: audio in/out proof, latency, barge-in, guard rails
npm run eval        # pointing accuracy across kiosk scenes (calibration must hit)
```

Read `docs/ARCHITECTURE.md` first (scope, module ownership, IPC/coordinate contracts) and
`docs/EVAL.md` for the eval harness and current measured numbers.

## Current limitations

- **Computer use is deliberately bounded** — every helper buddy has the same tool surface, but its
  first browser action must pass an explicit capability approval. It cannot borrow the user's
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
- **Helper buddy mode is currently macOS-only** — every helper receives one unified capability
  surface, and its required host-shell/filesystem workspace fails closed on Windows. Core voice,
  typed turns, pointing, and opt-in live-desktop computer use are available on both platforms.
- **Unsigned Windows binaries** — expect the SmartScreen warning.
- **macOS distribution builds need signing and notarization credentials** for a trusted release;
  ad-hoc builds are intentionally limited to disposable QA.
- One realtime session at a time; no wake word or first-party OAuth connector integrations yet.
  Helper buddies can still work in sites the user explicitly enrolls in Buddy's separate browser.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development
workflow and project invariants, and read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before
touching anything structural. Security issues go through [SECURITY.md](SECURITY.md), not the
public issue tracker.

## License

[MIT](LICENSE) © Fastyr, Inc.
