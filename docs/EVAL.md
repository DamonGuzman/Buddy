# Audio-Experience Eval Harness (M8.5)

Makes the voice experience measurable: proves real audio flows IN (through the actual
`getUserMedia` path) and OUT (samples actually rendered by the playback worklet), measures
per-turn latency, and scores how well the model points at on-screen elements. The SAME harness
runs against the mock (`tools/mock-realtime`) and — with `--live` — against the real OpenAI
Realtime API once a key exists.

Machine baseline for the numbers below: Windows 11, single 4K display @150% (2560×1440 DIP),
Node 24, production build (`npm run build`).

## 1. Architecture

| Piece              | Where                                                                                        | What it does                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake-mic injection | `src/main/index.ts` (bootstrap)                                                              | `CLICKY_FAKE_MIC=<path.wav>` routes Chromium's `getUserMedia` to a fake capture device playing that WAV (16-bit PCM, mono 24kHz preferred). Real renderer capture path end-to-end; only the physical microphone is substituted. Chromium **loops** the file; the push-to-talk hold window defines what is sent (utterances ~2–3s, hold ~3.5s). |
| Playback tap       | `pcm-player.worklet.js` → `playback.ts` → IPC `audio:playback-stats` / `audio:playback-ring` | The worklet accounts every sample it actually renders per response item (`samplesPlayed`, `rms`, `peak`, `underruns`, first-played wall time) and streams played Float32 back; the panel keeps a ~15s ring buffer of PLAYED audio and reports to main on first play, ~1s cadence, and item end.                                                |
| Turn timings       | `src/main/conversation.ts` (`TurnTimings`)                                                   | Per-turn epoch-ms marks: hold start/end (or ask), capture done, commit sent, first user/assistant transcript, first audio delta, **first audio actually played**, first tool call, response done, chunk counts, `bargeInStopMs`. Last 20 turns kept.                                                                                           |
| Debug routes       | `src/main/debug-server.ts`                                                                   | `GET /timings`, `GET /audio/output-stats`, `GET /audio/last-output.wav` (ring as 24k mono s16 WAV), `POST/GET /eval/ground-truth`. Light auth: when `CLICKY_DEBUG_TOKEN` is set, every route requires `X-Debug-Token` (or `?token=`). `CLICKY_DEBUG_PORT` overrides 8199 for parallel instances.                                               |
| Eval scenes        | `eval/scenes/*.html`                                                                         | Self-contained pages; every `[data-target]` measures its rect onload, converts to **global DIP** (CSS px == DIP at default zoom, offset by `screenX/screenY` + window chrome), and POSTs ground truth to the debug server.                                                                                                                     |
| Runners            | `eval/run.mjs`, `eval/voice-roundtrip.mjs`, `eval/verify-audio.mjs`, `eval/tts.mjs`          | See §3.                                                                                                                                                                                                                                                                                                                                        |

## 2. Metrics — targets vs. measured

Mock column measured 2026-07-12 (results in `eval/results/2026-07-12T07-31-18-voice/` and
`eval/results/2026-07-12T07-38-14/`; barge-in re-measured post-merge with the tap-derived metric,
`eval/results/2026-07-12T14-59-17-voice/`). Live column empty until an OpenAI key exists.

### 2a. Voice round-trip (×5, fake mic `ask-point-save.wav`, 3.5s hold) — medians

| Metric                                                             | Target      | Mock                  | Pass              | Live (2026-07-12, gpt-realtime-2.1-mini)                                        |
| ------------------------------------------------------------------ | ----------- | --------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Audio IN: mic chunks per hold                                      | > 0         | 57 chunks             | PASS              | 57 chunks — PASS                                                                |
| Audio IN: committed audio per 3.5s hold                            | > 2.5s      | 3.42 s                | PASS              | n/a (mock-only metric) — real ASR transcribed the WAV verbatim 5/5 — PASS       |
| Screenshot capture (kicked at hold-start)                          | < 1000ms    | 411 ms                | PASS              | 589 ms — PASS                                                                   |
| Release → commit sent                                              | < 100ms     | 1 ms                  | PASS              | 1 ms — PASS                                                                     |
| Release → first USER (ASR) transcript                              | report      | n/a                   |                   | 449 ms (p90 568)                                                                |
| Release → first audio delta (server overhead)                      | report      | 570 ms                | n/a (mock pacing) | **1496 ms** (p50 < 2.5s PASS; p90 incl. voice-pointing turns 2981 ms < 4s PASS) |
| **First audio delta → first audio PLAYED** (our playback pipeline) | < 150ms     | **10 ms**             | PASS              | 65 ms — PASS                                                                    |
| Release → response done                                            | report      | 787 ms                | n/a (mock pacing) | 4136 ms (p90 4705)                                                              |
| Played RMS                                                         | > 0.05      | 0.168                 | PASS              | 0.066 — PASS                                                                    |
| Underruns per turn                                                 | == 0        | 0                     | PASS              | 0 — PASS                                                                        |
| Spectral check (melody notes > 20dB over noise floor)              | all 3 notes | 26.9 / 24.5 / 27.7 dB | PASS              | n/a (speech, not the mock melody) — audible speech played 5/5 — PASS            |
| Played duration vs expected (5 turns × 1.4s melody)                | ±15%        | 7.14s ≈ 5.1 melodies  | PASS              | n/a (speech; drained in full each turn)                                         |

### 2b. Barge-in (×3: /ask a spoken response, hotkey press mid-speech)

| Metric                                                | Target  | Mock  | Pass | Live (2026-07-12)                                                                     |
| ----------------------------------------------------- | ------- | ----- | ---- | ------------------------------------------------------------------------------------- |
| Cancel requested → playback actually stopped (median) | < 300ms | 25 ms | PASS | 16 ms (16/16/16) — PASS, no post-cancel bleed (next turn's delta→played stayed 65 ms) |

Note: `bargeInStopMs` is now derived from the playback tap (`firstPlayedAt + samplesPlayed/rate`
of the cancelled item's final block), i.e. the wall time of the last rendered sample. The earlier
~285-356ms readings stamped `Date.now()` when main PROCESSED the done-stats IPC — the same hotkey
press kicks the screenshot resize/JPEG crunch in main, which delayed that handler by 100-300ms on
a 4K display; the renderer itself stops rendering ~10-25ms after the press.

### 2c. Text turn (×3, `/ask "hello there friend"`) — medians

| Metric                       | Target   | Mock    | Pass              | Live (2026-07-12) |
| ---------------------------- | -------- | ------- | ----------------- | ----------------- |
| Capture (blocking, pre-send) | < 1000ms | 370 ms  | PASS              | 745 ms — PASS     |
| Ask → first audio delta      | report   | 895 ms  | n/a (mock pacing) | 1972 ms           |
| First delta → first played   | < 150ms  | 9 ms    | PASS              | 141 ms — PASS     |
| Ask → response done          | report   | 1090 ms | n/a (mock pacing) | 3241 ms           |

### 2d. Guard rails

| Check                               | Target                                    | Mock                          | Pass | Live (2026-07-12)                                    |
| ----------------------------------- | ----------------------------------------- | ----------------------------- | ---- | ---------------------------------------------------- |
| Short hold (100ms)                  | no turn created, state returns idle       | no turn, idle                 | PASS | no turn, idle — PASS                                 |
| Silent hold (3.5s of `silence.wav`) | commits gracefully, reply, no error state | 3.42s committed, mock replied | PASS | committed, model replied gracefully, no error — PASS |

### 2e. Pointing (20 targets across 5 scenes)

**MOCK LIMITATION:** the mock always points at the center of screen0 regardless of the ask, so
the mock run validates PLUMBING (pointer fires per turn, screenshot-px → global-DIP mapping,
ground-truth reporting, scoring math) — **not model accuracy**. The `calibration` scene's target
covers the display center and MUST hit.

| Check                                            | Target                     | Mock                                                 | Pass        | Live (2026-07-12)                                                                                                                                                     |
| ------------------------------------------------ | -------------------------- | ---------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every ask produces a mapped pointer command      | 20/20                      | 20/20 (0 errors)                                     | PASS        | 20/20 after the persona no-refusal fix (8/20 refusal/timeout errors before it) — PASS                                                                                 |
| Calibration target (display center)              | hit                        | HIT, 0px error                                       | PASS        | HIT, **0px error** (model pointed exactly at 1280,720) — PASS                                                                                                         |
| Mapped point == display center on 2560×1440@150% | (1280,720)                 | (1280,720) every turn                                | PASS        | n/a (real model points at real targets)                                                                                                                               |
| Hit rate on real targets                         | ≥ 80% hit+near (live only) | 1 hit / 2 near / 17 miss (expected: center-pointing) | n/a on mock | mini: 2 hit / 3 near / 13 miss / 1 honest "can't see" on 19 scene targets (26% hit+near) — **FAIL** (model localization; labels correct on all 18 pointed — see §7.4) |

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

| Scene         | Targets (`data-target`)                        | Notes                                                                           |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `calibration` | calibration-center                             | 40vw×34vh block over the display center; the mock MUST hit it (pipeline proof). |
| `app-toolbar` | menu-file, save, open, export, settings, share | Fake editor chrome; large distinct colored toolbar buttons + menu bar.          |
| `form`        | email, password, subscribe, submit             | Labeled signup form; includes a small 26px checkbox.                            |
| `shop`        | search, cart, price, add-to-cart, reviews      | Realistic product page; header search + cart icon, price, reviews link.         |
| `tricky`      | save, save-as, small-icon, edge-button         | Adjacent near-identical buttons, a 24px icon, a control at the screen corner.   |

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

| Metric                                             |     p50 |     p90 | Gate                        |
| -------------------------------------------------- | ------: | ------: | --------------------------- |
| release → commit                                   |    1 ms |    2 ms | PASS (<100ms)               |
| release → first user (ASR) transcript              |  449 ms |  568 ms | report                      |
| release → first pointer (tool call, pointing asks) | 1306 ms | 2468 ms | report                      |
| release → first audio delta                        | 1623 ms | 2981 ms | **PASS** (p50<2.5s, p90<4s) |
| first delta → first played                         |   65 ms |   97 ms | PASS (<150ms)               |
| release → response done                            | 3911 ms | 4705 ms | report                      |

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

| scene       | model | hit | near (≤40 DIP) | miss |                        error | median err px (pointed turns) |
| ----------- | ----- | --: | -------------: | ---: | ---------------------------: | ----------------------------: |
| app-toolbar | mini  |   2 |              0 |    4 |                            0 |                           109 |
| form        | mini  |   0 |              2 |    2 |                            0 |                            81 |
| shop        | mini  |   0 |              1 |    4 |                            0 |                           210 |
| tricky      | mini  |   0 |              0 |    3 | 1 ("can't see" the 8px bell) |                           609 |
| tricky      | full  |   0 |              2 |    2 |                            0 |                           143 |
| shop        | full  |   2 |              0 |    3 |                            0 |                           144 |

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

| Check                                | Result                                  | Gate                                                                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brevity (≤~4 sentences)              | 33/33                                   | PASS                                                                                                                                                                                                                                                            |
| ear-not-eye (no lists/URLs/markdown) | 33/33                                   | PASS                                                                                                                                                                                                                                                            |
| plants-a-seed                        | 33/33 (even the refusals planted seeds) | PASS (≥60%)                                                                                                                                                                                                                                                     |
| all-lowercase (raw transcript)       | 13/33 (39%)                             | **FAIL as raw text** — but every user-visible surface (overlay caption, panel) enforces lowercase via CSS `text-transform`, and spoken audio carries no case. Classified: uncontrollable ASR-style casing in the audio transcript, already mitigated by design. |
| "clicky, agent" stub                 | friendly coming-soon line, lowercase    | PASS                                                                                                                                                                                                                                                            |

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
| ----- | --------: | -----------------: | -------: | -------: | -----------------: |
| mini  |        34 |   126,572 (99,589) |   50,711 |      859 |    17,541 (10,062) |
| full  |         9 |    38,550 (32,282) |   16,150 |        0 |      3,286 (2,192) |

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

Recommendations 1 and 2 were executed as M8.6 — see §8 for the re-gate results and the final
configuration decision.

## 8. Pointing re-gate (M8.6, 2026-07-12)

Same machine (4K@150%, 2560×1440 DIP), same scenes/gates as §7.3. Changes under test:
capture cap raised **1280 → 2048** px longest edge (`CAPTURE_MAX_EDGE`, `shared/constants.ts`;
each image px now covers 1.25 DIP instead of 2 DIP), model ladder mini → full, and one
prompt-side lever (coordinate anchors + a fraction→pixel worked example in the image-framing
text, `session.ts buildImageContent`). Gates: unambiguous scenes (toolbar/form/shop, 15
targets) strict ≥70%, strict+near ≥90%.

### 8.1 Config matrix

Strict / strict+near on the 15 unambiguous targets; "median err" is over pointed turns on
those scenes (px, global DIP). Calibration hit in every run (0-30px), so the mapping pipeline
stayed exact throughout.

| config (resolution × model × lever)              | strict | strict+near | median err | worst err | tricky (4)                    | evidence                                                |
| ------------------------------------------------ | -----: | ----------: | ---------: | --------: | ----------------------------- | ------------------------------------------------------- |
| 1280 × mini × none (§7.3 baseline)               |    13% |         40% |       ~110 |       714 | 0 hit                         | §7.7                                                    |
| 2048 × mini × none                               | **0%** |         27% |        150 |       615 | 0 hit, all miss               | `results/2026-07-12T16-59-46`                           |
| 2048 × full × none                               |    33% |         53% |        105 |       239 | 2 hit (24px icon at 10px err) | `results/2026-07-12T17-03-09`                           |
| 2048 × full × anchors v1 (incl. center landmark) |    27% |         47% |         88 |       482 | 2 hit 2 near                  | `results/2026-07-12T17-07-31`                           |
| 2048 × full × anchors v2 (corners only, final)   | 40-47% |         53% |         90 |       533 | 1 hit 2 near                  | `results/2026-07-12T17-10-12`, shop re-run `…T17-12-58` |

Per-scene notes (why the lever is a wash overall but ships anyway):

- **mini did NOT benefit from 2048** — its coordinate frame is mis-scaled regardless of input
  resolution (at 2048 it drifted the opposite direction: expansion ~1.2-1.4x down-right vs
  the compression seen at 1280). Resolution was never mini's bottleneck; its localization is.
- **full clearly benefits from 2048**: finds every small element (24px tricky icon HIT at
  10px, 30px menu item HIT at 13px, screen-corner button HIT at 8px — all impossible at
  1280), and its worst-case error dropped ~3x vs mini.
- **anchors lever**: dramatic on top-left-anchored UI — toolbar went 2 hit → 5 hit + 1 near
  (errors 2-90px), form errors halved, tricky's twin save/save-as disambiguated — but it
  _pulls left-column targets toward the horizontal center_ on the realistic shop page
  (reviews/price/add-to-cart missed right by 180-530px in both lever runs; without the lever
  shop was full's best scene). v1's explicit "center (1024,576)" landmark caused literal
  center-snapping (3 targets pointed at exactly x=1024) and was removed in v2.
- Drift measured across all runs is **scene-dependent in sign and magnitude** (toolbar
  compresses x toward origin without the lever, shop pulls toward center with it, form drifts
  y only) — NOT a stable linear transform, so a response-side affine/display-profile
  correction was evaluated and rejected as unsound.

### 8.2 Final configuration (shipped)

**`gpt-realtime-2.1` (full) default + 2048px capture + coordinate-anchor framing.**

- `CAPTURE_MAX_EDGE` 1280 → 2048 (`src/shared/constants.ts`).
- `DEFAULT_SETTINGS.model` / `DEFAULT_MODEL` → `'gpt-realtime-2.1'` (orchestrator-approved;
  `src/shared/types.ts`, `src/shared/constants.ts`). mini stays selectable — settings load
  validation fixed to accept both ids so a stored mini choice survives the default flip
  (`src/main/settings.ts`). Panel labels now say mini = faster/cheaper, full = best pointing.
- Image-framing text now states the coordinate convention with corner anchors + a
  fraction→pixel worked example and an anti-center-default instruction
  (`src/main/realtime/session.ts`). Rationale: toolbar/menu/form chrome is the primary MVP
  pointing surface and improved 2-4x; the shop-style regression is documented above.

### 8.3 Gate verdicts at the final configuration

| Gate                                               | Target         | Measured                                                                                                      | Verdict                        |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Pointing strict (unambiguous)                      | ≥70%           | 40-47% (6-7/15)                                                                                               | **FAIL**                       |
| Pointing strict+near                               | ≥90%           | 53% (8/15)                                                                                                    | **FAIL**                       |
| Capture latency at 2048                            | <800ms         | 564ms median voice-path (487-1094; one outlier >800), 436-446ms text-path (vs 343-411ms at 1280)              | PASS (median)                  |
| Release → first audio delta (voice ×5, full model) | p50 <2.5s      | **p50 1997ms** (1693-2513)                                                                                    | PASS                           |
| First delta → first played                         | <150ms         | 10-65ms                                                                                                       | PASS                           |
| Barge-in stop                                      | <300ms         | 26ms ×3                                                                                                       | PASS                           |
| Voice-driven pointing loop (toolbar, fake mic)     | loop completes | 5/5 attempted turns: real ASR verbatim, pointer fired, audio played (2 hit / 3 miss — in line with text mode) | PASS (loop), accuracy as above |
| Ask → first pointer (text)                         | report         | p50 ~1.7s, p90 ~2.4s (full; mini 2.1/2.8)                                                                     | —                              |

Token/latency cost of 2048: ~3.4k image tokens/response (~2.3x the 1280 cost), absorbed
almost entirely by caching within a session (94% of input tokens cached across the runs);
ask→pointer p50 actually _improved_ on full (1.7s at 2048 vs mini's 1.5s at 1280 §7.2, and
full-at-2048 beat mini-at-2048's 2.1s). The full model adds no measurable latency penalty
over mini on this workload — the p50 voice gate passes with 500ms of headroom.

M8.6 spend: 89 scored turns / 178 responses (+~15 unscored: voice round-trip phases,
evidence turns) — 1.05M input tokens (95% cached), 27k output. Estimated **≈$1.50-2.00**
at published gpt-realtime(-mini) rates.

Evidence: run dirs listed in the matrix; live-point screenshot (buddy on the Save button
with label chip + lowercase caption, verified by reading the 4K PNG):
`eval/results/2026-07-12-m8.6-evidence/live-point-save.png`.

Known harness/robustness follow-ups found during M8.6 (not pointing-related):
`app-toolbar--menu-file` was missing from the utterance catalog, so the voice run scored 5/6
with 1 harness error (fixed: catalog entry + wav added). And one live voice-roundtrip run
wedged after barge-in when a ~60ms hold was committed — the API rejects commits under 100ms
of audio ("buffer too small"), the session entered error state and the next turn timed out;
open follow-up: the hold-side guard should skip the commit below the server minimum.

### 8.4 Honest assessment — pointing UX today

The strict gates remain **NO-GO at every tested configuration**. What ships is the best
measured combination, and its real-world shape is:

- **Reading/labeling is solved** — the model names the right element essentially every time,
  in both voice and text; ASR, latency, barge-in and persona all pass with margin.
- **Coarse pointing is credible**: on toolbar/menu/form chrome the buddy now lands on or
  within a finger's width of the target (median ~50-90px ≈ one button off at worst); small
  icons are found. On dense/realistic pages a miss can still be half a card away.
- The residual error is the model's **image-space coordinate estimation**, which is
  scene-dependent and not correctable by resolution (mini), prompting (only partially), or a
  fixed affine (drift isn't stable). This is a model-capability ceiling today.

Post-MVP path to actually pass the gates: **element snapping** — enumerate on-screen
elements via UIA (`IUIAutomation` tree walk, ~50-200ms cached per foreground window) and/or
OCR (Windows.Media.Ocr on the existing capture), then snap the model's point to the nearest
element whose name/role matches the spoken label (the label is already near-perfect, so
label-matching does most of the work and the coordinate only breaks ties). Estimated effort:
UIA provider + label matcher + overlay snap ≈ 1-2 weeks including tests; it also unlocks
click-through "do it for me" later. Alternative/complement: a per-turn grounding call to a
dedicated vision model with known-good localization, at +1 round-trip of latency.

Executed as M9 — see §9.

## 9. Element-snap grounding re-gate (M9, 2026-07-12)

Same machine (4K@150%, 2560×1440 DIP), same scenes/gates as §7.3/§8. New under test:
**UIA element snapping** — ground the model's point to the real on-screen element that
matches its spoken label — plus the §8.3 quick-commit bug fix.

### 9.1 Snap architecture

A persistent PowerShell daemon (`src/main/grounding/snapper.ps1`, embedded at build, spawned
lazily + warmed at startup, restarted on crash, killed on quit; JSON lines over stdio)
resolves the top-level window under the model's mapped point with Win32 `WindowFromPoint`
(mouse hit-test semantics — skips Clicky's own click-through overlays, sees exactly what the
user sees; the daemon makes itself Per-Monitor-V2 DPI-aware so user32 and UIA agree on
physical px) and enumerates nearby named UIA elements: rect-pruned ControlView DFS under the
window, CacheRequest-batched properties, ±350px search radius (one retry at 700px), node/time
budgets. Selection is pure TS (`grounding/scoring.ts`): stopword/punctuation-normalized fuzzy
token similarity between the spoken label and element Names (max of token-dice,
name-coverage, damped label-in-name containment, whole-string Levenshtein), threshold 0.55,
small proximity tie-break. The whole snap is timeboxed at **600ms**; on no-match/timeout the
raw model point is used unchanged — snapping is never worse than §8. The label chip keeps the
model's words; `CLICKY_NO_SNAP=1` gives the A/B baseline; `POST /grounding/query` drives the
snapper model-free. Two daemon lessons baked in: UIA's own `ElementFromPoint` ignores
hit-test transparency (it kept landing on Clicky's overlay), and a DPI-unaware daemon mixes
virtualized user32 px with physical UIA px — both broke window resolution before the final
design. Plus one harness lesson: a machine-wide external extension pops an "added to
Microsoft Edge" bubble over fresh kiosk profiles, overlaying scene toolbars in screenshots
AND the UIA tree (`--disable-extensions` now).

### 9.2 Snapper sanity (no model, `POST /grounding/query`)

Eval toolbar scene in an Edge kiosk, probed at target-center ± a model-like drift
(+120, ±40 DIP): **6/6 targets matched and snapped inside their rects** — `File` @1.0,
`💾 Save`/`📂 Open`/`⇮ Export`/`⚙ Settings`/`🔗 Share` @0.85. Real apps: taskbar
`File Explorer` @0.85, `Microsoft Edge` @1.0. Daemon latency: 21-111ms warm on the kiosk
scene, ~590ms on the very first Edge query (Chromium a11y warm-up), 227-234ms on the
taskbar. Occlusion semantics verified: when another window covers the probe point the
snapper scopes the covering window — the same thing the capture (and user) sees.

### 9.3 Pointing re-gate (live, snapping ON) — the gates finally pass

`node eval/run.mjs --live`, all 5 scenes (20 targets), final §8.2 config + snapping ON,
2026-07-12 (`eval/results/2026-07-12T20-23-46/`):

| scene       |    hit |  near |  miss | notes                                                                                                                                                     |
| ----------- | -----: | ----: | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| calibration |      1 |     0 |     0 | 0px error — mapping pipeline still exact                                                                                                                  |
| app-toolbar |      6 |     0 |     0 | every snap @1.0 incl. the 30px File menu item                                                                                                             |
| form        |      4 |     0 |     0 | incl. the 26px checkbox (label→"Send me the monthly product newsletter" @0.7)                                                                             |
| shop        |      4 |     0 |     1 | miss = price (model label carried no "$249.00" this run → no name match → raw point, 168px off); cart HIT on the raw point (emoji-only name, unsnappable) |
| tricky      |      3 |     1 |     0 | save/save-as twins both disambiguated @1.0; near = the 24px emoji bell (no UIA name → raw point, 19px off)                                                |
| **total**   | **18** | **1** | **1** | 0 errors                                                                                                                                                  |

**Unambiguous scenes (toolbar/form/shop, 15 targets): strict 14/15 = 93% (gate ≥70%),
strict+near 14/15 = 93% (gate ≥90%) — BOTH PASS**, for the first time in any
configuration. Tricky: 3 hit / 1 near of 4.

### 9.4 Snap attribution + no-snap A/B

Attribution recorded per turn (`PointerCommand.snap`: raw vs snapped point): 16/20 turns
snapped; on the same turns the RAW model points would have scored **5 hit / 4 near / 11
miss** (unambiguous: 3/15 strict = 20%) — snapping converted **13 raws into hits and broke
0** (it never moved a raw hit off-target; the 4 unsnapped turns fell back to the raw point
by design). A/B control, same scene minutes apart: `--live --no-snap --scenes shop`
(`eval/results/2026-07-12T20-26-12/`) scored 2 hit / 1 near / 2 miss (40% strict) vs 4 hit /
1 miss (80%) with snapping — consistent with §8's 40-47% ceiling for raw pointing.

Snap latency across the run: **p50 49ms, p90 90ms**, max 370ms (a no-match that took the
700px-radius retry); matched-only p50 45ms. Ask→first tool call p50 1591ms (p90 1977) —
grounding adds ~50ms p50 / ~90ms p90 to pointer arrival (target <300ms p90 — PASS).

### 9.5 Quick-commit fix + latency (partial — run interrupted)

The §8.3 wedge is fixed at three layers: (1) `finishVoiceTurn` cancels instead of
committing when the hold appended <200ms of mic audio (the 100ms-server-minimum class),
(2) the session synthesizes a failed `response-done` if the API still rejects a commit
("buffer too small"/"buffer is empty"), so `pendingResponses` can never wedge — regression
tests cover both (`tests/conversation-hold.test.ts`, `tests/realtime.test.ts` M9 case;
`tools/mock-realtime` now mirrors the real API's 100ms commit minimum), and (3) the
voice-roundtrip harness retries a guarded-cancel turn once. The guard was also validated
LIVE by accident: one hold in the (interrupted) live voice run delivered only 180ms of mic
audio — the app logged `hold carried only 180ms of audio (< 200ms) — cancelling instead of
committing` and settled back to idle with no commit, no error state, and the next turn
working: exactly the scenario that error-wedged M8.6.

Live voice latency (partial: 6 completed turns across runs interrupted by the operator —
the machine was in active use): release→first audio delta 1023/1379/1446/2730/2798/2808ms
(median ~2.1s, informal p50 <2.5s), first delta→first played 2-61ms, rms 0.058-0.065,
0 underruns. A formal 5-turn latency pass + the 3-turn voice-loop spot check were NOT
completed.

### 9.6 Gate verdicts

| Gate                                            | Target     | Measured                                                                                  | Verdict                                  |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Pointing strict (unambiguous)                   | ≥70%       | **93%** (14/15)                                                                           | **PASS**                                 |
| Pointing strict+near                            | ≥90%       | **93%** (14/15)                                                                           | **PASS**                                 |
| Snap overhead on pointer arrival                | <300ms p90 | 90ms p90 (49ms p50)                                                                       | PASS                                     |
| Release → first audio delta                     | p50 <2.5s  | ~2.1s median over 6 turns (informal)                                                      | PENDING (formal 5-turn pass interrupted) |
| Voice loop spot-check + live quick-tap barge-in | no wedge   | guard fired live once, clean recovery (accidental coverage); dedicated spot-check not run | PENDING                                  |
| Unit tests / build                              | green      | 152/152, build green                                                                      | PASS                                     |

**Live re-gate status: pointing PASSED as above; the remaining latency/voice-loop passes
were interrupted by the user (on-screen kiosk testing while the machine was in active use)
and are deferred — rerun `node eval/voice-roundtrip.mjs --live` plus a 3-turn voice spot
check when convenient.** M9 live spend: ~305k input tokens (96% cached) + ~6.2k output
across the pointing runs, plus ~10 voice/interrupted turns — estimated **≈$0.40-0.60** at
published gpt-realtime rates (M8.6 methodology).

### 9.7 Known limitations

- **Elements with no UIA Name can't snap**: emoji-only glyph buttons (the shop cart 🛒, the
  tricky bell 🔔) and canvas-drawn UI fall back to the raw model point (cart still hit raw;
  bell was near). OCR over the existing capture is the natural complement.
- The snapper trusts hit-test semantics: it grounds against the window the USER sees at the
  point — occluded windows are invisible to it (matches what the capture shows, verified).
- The label does the work: if the model's spoken label shares no tokens with the on-screen
  name (shop price this run: "the price" vs "$249.00"), no snap. §7-§8 showed labels are
  usually verbatim-quality, so this is rare (1/20 this run; threshold 0.55 errs toward the
  safe raw fallback).
- First UIA query against a fresh Chromium window costs ~600ms (a11y warm-up) — inside the
  timebox but occasionally a first-turn snap falls back; the daemon warm-up at app start
  hides the PowerShell/assembly load itself.
- `run.mjs --voice` still relaunches the app per target; the mock voice-roundtrip passes
  all gates with the new commit guard (2026-07-12, `2026-07-12T18-20-32-voice`).

## 10. Layered grounding — headless validation (M10, 2026-07-12)

M10 adds the REST grounding fallback behind native accessibility (uia/ax → rest → raw;
docs/ARCHITECTURE.md §6b, rationale in docs/COORD-STUDY.md §8-§9): when the snap finds no
match, `rest-grounder.ts` re-grounds the model's spoken label with **gpt-5.4-mini (reasoning
effort low, bare screenshot, strict-JSON pixel coords)** against the same JPEG the realtime
model saw.

**Headless validation (no app, no windows, nothing on screen):** the PRODUCTION module
(`src/main/grounding/rest-grounder.ts`, imported directly by the env-gated
`tests/rest-grounder.live.test.ts`, `CLICKY_LIVE_GROUND=1`) was run live against the
coord-study ground truth — 12 synthetic layout-A targets (exact by construction) + 3
hand-measured real-screenshot targets, all 2048x1152:

| target        | kind      | err px | in-element | latency |
| ------------- | --------- | -----: | ---------- | ------: |
| save          | synthetic |      1 | yes        |  2023ms |
| open          | synthetic |     16 | yes        |  1407ms |
| help          | synthetic |      3 | yes        |  1470ms |
| exit          | synthetic |      1 | yes        |  1647ms |
| start         | synthetic |     20 | yes        |  1548ms |
| cart          | synthetic |     10 | yes        |  1444ms |
| send          | synthetic |      7 | yes        |  1635ms |
| copy          | synthetic |      2 | yes        |  1713ms |
| paste         | synthetic |      1 | yes        |  2081ms |
| cut           | synthetic |      5 | yes        |  1330ms |
| dot (24px)    | synthetic |     17 | no         |  1429ms |
| square (16px) | synthetic |      8 | yes        |  1418ms |
| clock         | real      |     24 | yes        |  1996ms |
| review        | real      |     13 | yes        |  1768ms |
| openin        | real      |     12 | yes        |  1556ms |

**Summary: 15/15 valid responses, median 8px, max 24px, 14/15 in-element (93%), latency p50
1556ms / max 2081ms** (raw records: `eval/experiments/coord-study/results/
m10-live-validation.json`) — matches the study's 10px / 93% / 1.3s within noise (the +0.25s
p50 vs the study is the Responses-API strict-schema path vs chat completions; still well
under the 2.5s fallback timeout). Dispatch-precedence + failure-path behavior (uia hit → no
rest call; uia miss → rest; rest null → raw; superseded turn → no pointer; timeout/garbage/
out-of-bounds/no-key/mock-mode → null) is covered offline by `tests/rest-grounder.test.ts`
and `tests/grounding-layered.test.ts` (170/170 green). Validation spend: 30 REST calls
(two 15-target passes) ≈ **$0.03** at mini rates.

**Layered grounding validated headlessly as above; the full ON-SCREEN pointing re-gate
(§9.3 methodology, kiosk scenes, `groundingSource` attribution across uia/ax/rest/raw) is
PENDING** — rerun `node eval/run.mjs --live` when the machine is free, plus an A/B with
`CLICKY_NO_REST_GROUND=1` to isolate the rest layer's contribution on unsnappable targets
(emoji glyphs, canvas UI — exactly §9.7's known gaps).
