# Audio-Experience Eval Harness (M8.5)

Makes the voice experience measurable: proves real audio flows IN (through the actual
`getUserMedia` path) and OUT (samples actually rendered by the playback worklet), measures
per-turn latency, and scores how well the model points at on-screen elements. The SAME harness
runs against the mock (`tools/mock-realtime`) and — with `--live` — against the real OpenAI
Realtime API once a key exists.

Machine baseline for the numbers below: Windows 11, single 4K display @150% (2560×1440 DIP),
Node 24, production build (`npm run build`).

## 1. Architecture

| Piece | Where | What it does |
|---|---|---|
| Fake-mic injection | `src/main/index.ts` (bootstrap) | `CLICKY_FAKE_MIC=<path.wav>` routes Chromium's `getUserMedia` to a fake capture device playing that WAV (16-bit PCM, mono 24kHz preferred). Real renderer capture path end-to-end; only the physical microphone is substituted. Chromium **loops** the file; the push-to-talk hold window defines what is sent (utterances ~2–3s, hold ~3.5s). |
| Playback tap | `pcm-player.worklet.js` → `playback.ts` → IPC `audio:playback-stats` / `audio:playback-ring` | The worklet accounts every sample it actually renders per response item (`samplesPlayed`, `rms`, `peak`, `underruns`, first-played wall time) and streams played Float32 back; the panel keeps a ~15s ring buffer of PLAYED audio and reports to main on first play, ~1s cadence, and item end. |
| Turn timings | `src/main/conversation.ts` (`TurnTimings`) | Per-turn epoch-ms marks: hold start/end (or ask), capture done, commit sent, first user/assistant transcript, first audio delta, **first audio actually played**, first tool call, response done, chunk counts, `bargeInStopMs`. Last 20 turns kept. |
| Debug routes | `src/main/debug-server.ts` | `GET /timings`, `GET /audio/output-stats`, `GET /audio/last-output.wav` (ring as 24k mono s16 WAV), `POST/GET /eval/ground-truth`. Light auth: when `CLICKY_DEBUG_TOKEN` is set, every route requires `X-Debug-Token` (or `?token=`). `CLICKY_DEBUG_PORT` overrides 8199 for parallel instances. |
| Eval scenes | `eval/scenes/*.html` | Self-contained pages; every `[data-target]` measures its rect onload, converts to **global DIP** (CSS px == DIP at default zoom, offset by `screenX/screenY` + window chrome), and POSTs ground truth to the debug server. |
| Runners | `eval/run.mjs`, `eval/voice-roundtrip.mjs`, `eval/verify-audio.mjs`, `eval/tts.mjs` | See §3. |

## 2. Metrics — targets vs. measured

Mock column measured 2026-07-12 (results in `eval/results/2026-07-12T07-31-18-voice/` and
`eval/results/2026-07-12T07-38-14/`; barge-in re-measured post-merge with the tap-derived metric,
`eval/results/2026-07-12T14-59-17-voice/`). Live column empty until an OpenAI key exists.

### 2a. Voice round-trip (×5, fake mic `ask-point-save.wav`, 3.5s hold) — medians

| Metric | Target | Mock | Pass | Live |
|---|---|---|---|---|
| Audio IN: mic chunks per hold | > 0 | 57 chunks | PASS | |
| Audio IN: committed audio per 3.5s hold | > 2.5s | 3.42 s | PASS | |
| Screenshot capture (kicked at hold-start) | < 1000ms | 411 ms | PASS | |
| Release → commit sent | < 100ms | 1 ms | PASS | |
| Release → first audio delta (server overhead) | report | 570 ms | n/a (mock pacing) | |
| **First audio delta → first audio PLAYED** (our playback pipeline) | < 150ms | **10 ms** | PASS | |
| Release → response done | report | 787 ms | n/a (mock pacing) | |
| Played RMS | > 0.05 | 0.168 | PASS | |
| Underruns per turn | == 0 | 0 | PASS | |
| Spectral check (melody notes > 20dB over noise floor) | all 3 notes | 26.9 / 24.5 / 27.7 dB | PASS | |
| Played duration vs expected (5 turns × 1.4s melody) | ±15% | 7.14s ≈ 5.1 melodies | PASS | |

### 2b. Barge-in (×3: /ask a spoken response, hotkey press mid-speech)

| Metric | Target | Mock | Pass | Live |
|---|---|---|---|---|
| Cancel requested → playback actually stopped (median) | < 300ms | 25 ms | PASS | |

Note: `bargeInStopMs` is now derived from the playback tap (`firstPlayedAt + samplesPlayed/rate`
of the cancelled item's final block), i.e. the wall time of the last rendered sample. The earlier
~285-356ms readings stamped `Date.now()` when main PROCESSED the done-stats IPC — the same hotkey
press kicks the screenshot resize/JPEG crunch in main, which delayed that handler by 100-300ms on
a 4K display; the renderer itself stops rendering ~10-25ms after the press.

### 2c. Text turn (×3, `/ask "hello there friend"`) — medians

| Metric | Target | Mock | Pass | Live |
|---|---|---|---|---|
| Capture (blocking, pre-send) | < 1000ms | 370 ms | PASS | |
| Ask → first audio delta | report | 895 ms | n/a (mock pacing) | |
| First delta → first played | < 150ms | 9 ms | PASS | |
| Ask → response done | report | 1090 ms | n/a (mock pacing) | |

### 2d. Guard rails

| Check | Target | Mock | Pass | Live |
|---|---|---|---|---|
| Short hold (100ms) | no turn created, state returns idle | no turn, idle | PASS | |
| Silent hold (3.5s of `silence.wav`) | commits gracefully, reply, no error state | 3.42s committed, mock replied | PASS | |

### 2e. Pointing (20 targets across 5 scenes)

**MOCK LIMITATION:** the mock always points at the center of screen0 regardless of the ask, so
the mock run validates PLUMBING (pointer fires per turn, screenshot-px → global-DIP mapping,
ground-truth reporting, scoring math) — **not model accuracy**. The `calibration` scene's target
covers the display center and MUST hit.

| Check | Target | Mock | Pass | Live |
|---|---|---|---|---|
| Every ask produces a mapped pointer command | 20/20 | 20/20 (0 errors) | PASS | |
| Calibration target (display center) | hit | HIT, 0px error | PASS | |
| Mapped point == display center on 2560×1440@150% | (1280,720) | (1280,720) every turn | PASS | |
| Hit rate on real targets | ≥ 80% hit+near (live only) | 1 hit / 2 near / 17 miss (expected: center-pointing) | n/a on mock | |

Scoring: **hit** = mapped global-DIP point inside the target rect; **near** = within 40 DIP of
the rect; **miss** otherwise; plus px error from rect center. Results:
`eval/results/<timestamp>/results.json` + `results.md`.

## 3. How to re-run

```powershell
# one-time: build + TTS wavs (SAPI, 24kHz 16-bit mono; also silence.wav)
npm run build
npm run eval:tts             # node eval/tts.mjs [--force]

# audio round-trip eval (phases A-E; starts its own mock + app, cleans up)
npm run eval:voice           # node eval/voice-roundtrip.mjs

# pointing eval (opens Edge kiosk scenes fullscreen briefly, then closes them)
npm run eval                 # node eval/run.mjs

# spectral check of whatever the app last played (standalone)
node eval/verify-audio.mjs --url http://127.0.0.1:8199 --token <token>

# useful flags
node eval/run.mjs --scenes calibration,form   # subset
node eval/run.mjs --attach                    # drive an already-running app
node eval/run.mjs --debug-port 8299           # avoid another instance's 8199
node eval/run.mjs --voice                     # voice asks via fake mic (slow:
                                              # relaunches the app per target)
```

Both runners launch the built app themselves with an isolated `CLICKY_USER_DATA`, a random
`CLICKY_DEBUG_TOKEN`, and (mock mode) their own mock server, and kill their own processes on
exit — safe to run while other dev instances exist (use `--debug-port` if 8199 is taken).

### Live mode (once a key exists)

```powershell
# key from settings (add via the panel) or the environment
node eval/voice-roundtrip.mjs --live
node eval/run.mjs --live            # real pointing accuracy per scene/target
node eval/run.mjs --live --voice    # full voice pointing (fake mic per target)
```

`--live` simply omits `CLICKY_MOCK_URL`, so the app connects to
`wss://api.openai.com/v1/realtime` with the key from settings. All metrics/gates and the
report format are identical — fill the "Live" columns above from the printed medians. The
"n/a (mock pacing)" rows become real end-to-end latency numbers in live mode.

## 4. Utterance catalog

`eval/utterances.json` → `eval/audio/<id>.wav` (System.Speech TTS, 24kHz 16-bit mono; verified
durations 1.9–3.5s). Core: `ask-point-save`, `ask-what-screen`, `ask-point-two`, `silence`
(generated zeros, not TTS). Per-target: `<scene>--<target>` for every scene target below
(used by `run.mjs --voice`).

## 5. Scene catalog (`eval/scenes/`)

| Scene | Targets (`data-target`) | Notes |
|---|---|---|
| `calibration` | calibration-center | 40vw×34vh block over the display center; the mock MUST hit it (pipeline proof). |
| `app-toolbar` | menu-file, save, open, export, settings, share | Fake editor chrome; large distinct colored toolbar buttons + menu bar. |
| `form` | email, password, subscribe, submit | Labeled signup form; includes a small 26px checkbox. |
| `shop` | search, cart, price, add-to-cart, reviews | Realistic product page; header search + cart icon, price, reviews link. |
| `tricky` | save, save-as, small-icon, edge-button | Adjacent near-identical buttons, a 24px icon, a control at the screen corner. |

Each page reports ground truth on load (twice, 400ms/1500ms) to
`POST /eval/ground-truth?token=…&port=…` as `{scene, targets:[{name, desc, rect}]}` in global
DIP. The runner opens scenes with `msedge --kiosk … --edge-kiosk-type=fullscreen` (Chrome
`--kiosk` fallback) under a throwaway `--user-data-dir`, and kills only its own browser tree.

## 6. Known limitations / follow-ups

- **Blocked on a live API key:** real pointing accuracy, real model latency numbers, live
  columns in §2 — everything else is measured now.
- The mock's ASR line ("mock transcript of N audio bytes") is how committed-audio seconds are
  derived; the live API returns a real transcription instead (the eval then checks the words).
- `tFirstAudioPlayed` uses `Date.now()` inside the audio worklet at the first rendered quantum;
  actual device output adds a few ms of hardware latency not visible from software.
- Barge-in truly stops playback in ~10-25ms (tap-derived); the old thin-margin ~285ms readings
  were main-loop congestion in the measurement path (see §2b note), not audible latency.
- `run.mjs --voice` relaunches the app per target (fake-capture file is a launch-time
  Chromium switch); expect ~15s per target.
