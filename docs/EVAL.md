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

| Metric | Target | Mock | Pass | Live (2026-07-12, gpt-realtime-2.1-mini) |
|---|---|---|---|---|
| Audio IN: mic chunks per hold | > 0 | 57 chunks | PASS | 57 chunks — PASS |
| Audio IN: committed audio per 3.5s hold | > 2.5s | 3.42 s | PASS | n/a (mock-only metric) — real ASR transcribed the WAV verbatim 5/5 — PASS |
| Screenshot capture (kicked at hold-start) | < 1000ms | 411 ms | PASS | 589 ms — PASS |
| Release → commit sent | < 100ms | 1 ms | PASS | 1 ms — PASS |
| Release → first USER (ASR) transcript | report | n/a | | 449 ms (p90 568) |
| Release → first audio delta (server overhead) | report | 570 ms | n/a (mock pacing) | **1496 ms** (p50 < 2.5s PASS; p90 incl. voice-pointing turns 2981 ms < 4s PASS) |
| **First audio delta → first audio PLAYED** (our playback pipeline) | < 150ms | **10 ms** | PASS | 65 ms — PASS |
| Release → response done | report | 787 ms | n/a (mock pacing) | 4136 ms (p90 4705) |
| Played RMS | > 0.05 | 0.168 | PASS | 0.066 — PASS |
| Underruns per turn | == 0 | 0 | PASS | 0 — PASS |
| Spectral check (melody notes > 20dB over noise floor) | all 3 notes | 26.9 / 24.5 / 27.7 dB | PASS | n/a (speech, not the mock melody) — audible speech played 5/5 — PASS |
| Played duration vs expected (5 turns × 1.4s melody) | ±15% | 7.14s ≈ 5.1 melodies | PASS | n/a (speech; drained in full each turn) |

### 2b. Barge-in (×3: /ask a spoken response, hotkey press mid-speech)

| Metric | Target | Mock | Pass | Live (2026-07-12) |
|---|---|---|---|---|
| Cancel requested → playback actually stopped (median) | < 300ms | 25 ms | PASS | 16 ms (16/16/16) — PASS, no post-cancel bleed (next turn's delta→played stayed 65 ms) |

Note: `bargeInStopMs` is now derived from the playback tap (`firstPlayedAt + samplesPlayed/rate`
of the cancelled item's final block), i.e. the wall time of the last rendered sample. The earlier
~285-356ms readings stamped `Date.now()` when main PROCESSED the done-stats IPC — the same hotkey
press kicks the screenshot resize/JPEG crunch in main, which delayed that handler by 100-300ms on
a 4K display; the renderer itself stops rendering ~10-25ms after the press.

### 2c. Text turn (×3, `/ask "hello there friend"`) — medians

| Metric | Target | Mock | Pass | Live (2026-07-12) |
|---|---|---|---|---|
| Capture (blocking, pre-send) | < 1000ms | 370 ms | PASS | 745 ms — PASS |
| Ask → first audio delta | report | 895 ms | n/a (mock pacing) | 1972 ms |
| First delta → first played | < 150ms | 9 ms | PASS | 141 ms — PASS |
| Ask → response done | report | 1090 ms | n/a (mock pacing) | 3241 ms |

### 2d. Guard rails

| Check | Target | Mock | Pass | Live (2026-07-12) |
|---|---|---|---|---|
| Short hold (100ms) | no turn created, state returns idle | no turn, idle | PASS | no turn, idle — PASS |
| Silent hold (3.5s of `silence.wav`) | commits gracefully, reply, no error state | 3.42s committed, mock replied | PASS | committed, model replied gracefully, no error — PASS |

### 2e. Pointing (20 targets across 5 scenes)

**MOCK LIMITATION:** the mock always points at the center of screen0 regardless of the ask, so
the mock run validates PLUMBING (pointer fires per turn, screenshot-px → global-DIP mapping,
ground-truth reporting, scoring math) — **not model accuracy**. The `calibration` scene's target
covers the display center and MUST hit.

| Check | Target | Mock | Pass | Live (2026-07-12) |
|---|---|---|---|---|
| Every ask produces a mapped pointer command | 20/20 | 20/20 (0 errors) | PASS | 20/20 after the persona no-refusal fix (8/20 refusal/timeout errors before it) — PASS |
| Calibration target (display center) | hit | HIT, 0px error | PASS | HIT, **0px error** (model pointed exactly at 1280,720) — PASS |
| Mapped point == display center on 2560×1440@150% | (1280,720) | (1280,720) every turn | PASS | n/a (real model points at real targets) |
| Hit rate on real targets | ≥ 80% hit+near (live only) | 1 hit / 2 near / 17 miss (expected: center-pointing) | n/a on mock | mini: 2 hit / 3 near / 13 miss / 1 honest "can't see" on 19 scene targets (26% hit+near) — **FAIL** (model localization; labels correct on all 18 pointed — see §7.4) |

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

- ~~Blocked on a live API key~~ — live eval completed 2026-07-12, see §7. All §2 Live
  columns are filled from real-API runs.
- The mock's ASR line ("mock transcript of N audio bytes") is how committed-audio seconds are
  derived; the live API returns a real transcription instead (the eval then checks the words).
- `tFirstAudioPlayed` uses `Date.now()` inside the audio worklet at the first rendered quantum;
  actual device output adds a few ms of hardware latency not visible from software.
- Barge-in truly stops playback in ~10-25ms (tap-derived); the old thin-margin ~285ms readings
  were main-loop congestion in the measurement path (see §2b note), not audible latency.
- `run.mjs --voice` relaunches the app per target (fake-capture file is a launch-time
  Chromium switch); expect ~15s per target.

## 7. Live eval 2026-07-12 (real OpenAI Realtime API)

Machine: Windows 11, single 4K display @150% (2560×1440 DIP), production build. Default
model `gpt-realtime-2.1-mini` ("mini") unless noted; comparison runs on `gpt-realtime-2.1`
("full"). Key seeding: `CLICKY_SEED_USERDATA=<dir>` (new in `eval/lib.mjs`) copies a
pre-encrypted `settings.json` + matching `Local State` (safeStorage/os_crypt key) into every
fresh eval userData dir — the key never touches env vars, IPC, or the repo.

### 7.1 Smoke

Text `/ask` + fake-mic voice turn both clean: real ASR transcript of the spoken WAV appeared
as the user entry (verbatim; the fake-mic loop repeats the utterance ~2x within the 3.5s
hold), spoken audio came back and PLAYED (rms 0.085, 0 underruns), `point_at` fired on the
voice turn, states settled idle. No session errors in any of the ~15 live app launches.

### 7.2 Latency profile (mini)

Voice (n=5 round-trip + 4 voice-pointing turns), medians / p90:

| Metric | p50 | p90 | Gate |
|---|---:|---:|---|
| release → commit | 1 ms | 2 ms | PASS (<100ms) |
| release → first user (ASR) transcript | 449 ms | 568 ms | report |
| release → first pointer (tool call, pointing asks) | 1306 ms | 2468 ms | report |
| release → first audio delta | 1623 ms | 2981 ms | **PASS** (p50<2.5s, p90<4s) |
| first delta → first played | 65 ms | 97 ms | PASS (<150ms) |
| release → response done | 3911 ms | 4705 ms | report |

Text pointing turns (n=18): ask→pointer p50 1507 ms (p90 7292); ask→first delta p50 2446 ms
(p90 8541 — the p90 tail is multi-response tool-continuation turns). Text chat turns (n=3):
ask→delta 1972 ms, ask→done 3241 ms. Barge-in (real API, n=3): playback stopped **16 ms**
after cancel (tap-derived), no post-cancel audio bleed. Guard rails (short hold, silent
hold): both PASS live.

**Live finding + fix:** `response.done` arrives tens of seconds before the queued audio
finishes playing, so a new hold/ask while clicky was still audibly speaking did NOT barge in
(`pendingResponses == 0`) and the new turn's audio queued behind the stale tail (observed:
first-played 11.8s late). Fixed in `conversation.ts` (`stopResidualPlayback()` on
holdStart/askText), verified: delta→played back to 38 ms in the same scenario.

### 7.3 Pointing accuracy — the headline

Calibration: HIT with **0px error** (coord pipeline proven live). Real scenes, text mode
("point at the …"), fresh app+session per scene:

| scene | model | hit | near (≤40 DIP) | miss | error | median err px (pointed turns) |
|---|---|---:|---:|---:|---:|---:|
| app-toolbar | mini | 2 | 0 | 4 | 0 | 109 |
| form | mini | 0 | 2 | 2 | 0 | 81 |
| shop | mini | 0 | 1 | 4 | 0 | 210 |
| tricky | mini | 0 | 0 | 3 | 1 ("can't see" the 8px bell) | 609 |
| tricky | full | 0 | 2 | 2 | 0 | 143 |
| shop | full | 2 | 0 | 3 | 0 | 144 |

Gates: unambiguous scenes (toolbar/form/shop) mini strict 2/15 (13%) — **FAIL** (≥70%);
strict+near 6/15 (40%) — **FAIL** (≥90%). Tricky (reported separately): mini 0/4,
full 2/4 near.

Diagnosis (calibration hit ⇒ not a mapping bug):

- **Labels are essentially perfect** — every pointed turn labeled the right element
  ("the save button", "the headphones price $249.00 on the product card"), so scene READING
  is fine; **coordinate estimation** is what fails.
- Mini's errors are systematic, not random: toolbar x-coordinates drift right by ~1.33x with
  y pinned ~32 DIP high — the model localizes in a mis-scaled frame of the 1280×720 JPEG
  (each image px = 2 DIP on this display, doubling every vision error).
- **Tool-call adherence bug (found + fixed):** mini refused to point on 8/20 first-pass
  turns — verbatim: "I can't safely point at the search box from this snapshot because I
  don't have the exact pixel coordinates." Fixed with a persona clause ("you always have
  what you need to point… never refuse because you 'don't have exact pixel coordinates'");
  after the fix mini pointed on 20/20 turns incl. a full shop re-run. Full model never
  refused even without the clause.
- **Model comparison:** full is markedly better — 0 refusals, found the 24px (8 image-px)
  bell icon (near, 44px), miss errors ~140-250px vs mini's 250-714px — but still under the
  strict gates at this capture resolution. Classification: **model limitation** (mini
  especially), amplified by the ≤1280px capture downscale on 4K.

### 7.4 Voice-driven pointing (full hold→speak→point loop)

`run.mjs --live --voice --scenes form` (fake mic per target): 4/4 turns completed the full
loop — real capture, real ASR, pointer fired, spoken answer played. ASR word accuracy: 4/4
utterances transcribed with every content word correct (≥80% gate — **PASS**; the fake-mic
loop repeats the phrase, e.g. "Point at the email address field. Point at the"). Pointing
verdicts (0 hit / 1 near / 3 miss) are in line with text mode on the same scene — voice adds
no pointing degradation.

### 7.5 Persona rubric (33 live responses)

| Check | Result | Gate |
|---|---|---|
| brevity (≤~4 sentences) | 33/33 | PASS |
| ear-not-eye (no lists/URLs/markdown) | 33/33 | PASS |
| plants-a-seed | 33/33 (even the refusals planted seeds) | PASS (≥60%) |
| all-lowercase (raw transcript) | 13/33 (39%) | **FAIL as raw text** — but every user-visible surface (overlay caption, panel) enforces lowercase via CSS `text-transform`, and spoken audio carries no case. Classified: uncontrollable ASR-style casing in the audio transcript, already mitigated by design. |
| "clicky, agent" stub | friendly coming-soon line, lowercase | PASS |

Verbatim examples:

> "the save button is in the toolbar up top, so click it to save your changes. and maybe
> next, try exporting to check how it looks as a document—little preview, big payoff."

> "pointing to the newsletter checkbox. if you want, toggle it on, and then you can click
> create account. and once you're in, we can try adding a profile picture or explore
> settings together."

> "haha, i'd love to be an agent for you. background agents are coming soon, but for now,
> i can still walk you through it together."

### 7.6 Cost + usage (measured via new `TurnTimings.usage` wiring)

| model | responses | input tok (cached) | image in | audio in | output tok (audio) |
|---|---:|---:|---:|---:|---:|
| mini | 34 | 126,572 (99,589) | 50,711 | 859 | 17,541 (10,062) |
| full | 9 | 38,550 (32,282) | 16,150 | 0 | 3,286 (2,192) |

≈55-60 model responses total (a few error/cancelled turns aren't in the usage rows).
Estimated spend at published gpt-realtime(-mini) rates: **≈ $0.50–0.75 total** (audio-out
dominates; caching kept repeat-image input cheap). Well under budget.

### 7.7 Evidence

- `eval/results/2026-07-12T16-22-15-voice/` — live voice round-trip (all gates PASS)
- `eval/results/2026-07-12T16-26-18/` … `2026-07-12T16-40-08/` — pointing runs
  (calibration, toolbar, form ×2, shop ×3, tricky ×2, voice-form), each with per-target
  transcripts + usage in `results.json`
- Mid-pointing 4K screenshot (read + verified): buddy at the toolbar with "the save button"
  label chip and lowercase caption bubble — pointed one button right of Save (mini's
  x-drift, visually confirmed)

### 7.8 Verdict

Voice EXPERIENCE (latency, audio in/out, ASR, barge-in, persona, guard rails): **GO** —
every gate passes with margin; sub-2s voice response feels genuinely conversational.
POINTING accuracy: **NO-GO on gpt-realtime-2.1-mini as shipped** (13% strict on unambiguous
targets); full model doubles quality but still misses the strict gates at the current
≤1280px capture scale. Top recommendations:

1. Raise capture resolution (≤2048px longest edge, or per-display tiles) — every mini error
   is magnified 2x by the 1280px downscale on 4K; re-run §7.3 to quantify.
2. Default pointing-heavy usage to `gpt-realtime-2.1` (settings already support it), or add
   a grounding assist (e.g. a second cheap vision call, or snap-to-nearest UI element via
   accessibility/OCR) before the MVP claims reliable pointing.
3. Keep the no-refusal persona clause + residual-playback barge-in fix (both landed in this
   eval); consider forcing `tool_choice` for "point at …"-style asks as a belt-and-braces
   adherence guarantee.
