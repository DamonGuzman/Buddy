# Clicky (heyclicky) — Research & UI/UX Analysis

> Compiled 2026-07-11. Sources listed at the end. Visual-design notes are synthesized from
> written sources and an engineering teardown (the Chrome extension wouldn't connect for
> firsthand screenshots); everything else is corroborated across the official site, the
> open-source repo, YC, and multiple reviews.

---

## 1. TL;DR

**Clicky** is a Mac-native AI assistant that lives _next to your cursor_ instead of in a chat
window. You hold a hotkey, talk to it out loud, and it (a) sees your screen, (b) answers in a
spoken voice, and (c) flies a little animated pointer across the screen to physically point at
the button/menu it's describing. Say **"Clicky, agent"** and it spawns a background agent to
actually do work (research, calendar, build things).

Its thesis is a **new interface paradigm for AI** — "point and talk" rather than "type into a
chatbox." It's from **Farza Majeed** (ex-Buildspace), went viral, and is in **YC Spring 2026**
with a reported **$10.1M** raised. Free tier + **$20/mo Pro**.

---

## 2. Company & Traction

|                 |                                                                                |
| --------------- | ------------------------------------------------------------------------------ |
| **Founder/CEO** | Farza Majeed (previously founded Buildspace, ~100k+ builders, wound down 2024) |
| **Batch**       | Y Combinator, Spring 2026 (partner: Aaron Epstein)                             |
| **Location**    | San Francisco                                                                  |
| **Funding**     | ~$10.1M reported                                                               |
| **Positioning** | "The simplest AI interface in the world for consumers to spawn agents"         |
| **Target user** | Everyday **consumers**, explicitly _not_ developers                            |

**Origin story:** Started as a _weekend side project_ in 2026. The demo video hit **~3M views**,
the open-source repo crossed **6,300+ GitHub stars**, and it went "tweet → YC company in weeks."
Farza's large existing audience (from Buildspace) is effectively the distribution channel — demos
reach millions organically.

**Reception:** #6 Product of the Day on Product Hunt (146 upvotes); XDA reportedly called it
"the most useful thing I've tried this year."

---

## 3. What It Does

Two modes:

1. **Ask / guide mode** — Hold **Ctrl+Option**, speak a question. It screenshots your monitors,
   analyzes them, replies in a spoken voice, and flies an animated pointer to the exact UI
   element it's referencing.
   - Marketed use cases: learning FL Studio, explaining an After Effects panel, Figma→code,
     comparing camera prices, designing a logo in Figma, summarizing a PDF then emailing it to a
     team.
2. **Agent mode** — Say _"Clicky, agent"_ and it spins up a background agent that can research,
   manage your calendar, or even build local Mac apps.
   - Native integrations touted: **Notion, Gmail, Google Calendar, Linear**.

---

## 4. How It Works (Technical Architecture)

Well-documented because it's **open source** (`farzaa/clicky`, ~95% Swift) with a good engineering
teardown by Isaac Flath.

- **Menu-bar app, not a dock app.** Two transparent `NSPanel` windows: one control-panel
  dropdown, one full-screen cursor overlay.
- **Overlay trick:** creates **one transparent, click-through, always-on-top overlay window per
  monitor**, floating above everything including menus/popups, joined across all Spaces so the
  "buddy" follows you between desktops. It never moves the real system cursor — it **draws its own
  blue triangle** inside the invisible overlay.
- **Pointing mechanism:** Claude (original stack) is prompted to emit coordinate tags like
  `[POINT:x,y:label:screenN]` _after_ its spoken text. Clicky strips the tag with regex — text
  goes to TTS, the coordinates drive the pointer. The triangle **arcs** to its target along a
  quadratic bezier (lifts a midpoint so the motion feels alive rather than linear).
- **Coordinate wrangling** (the hard part): screenshots are top-left origin, macOS displays are
  bottom-left origin on one shared multi-monitor grid, so it flips Y, scales to display size,
  applies per-monitor offsets, then converts AppKit→SwiftUI space.
- **Vision pipeline:** on hotkey, one screenshot per monitor, resized to max 1280px/dim at 80%
  quality, labeled so the model knows _which_ screen holds the cursor and prioritizes it. It
  filters out Clicky's own windows. Context sent = screenshots + live transcript + last 10
  exchanges.
- **Security:** API keys never ship in the binary — a **Cloudflare Worker** proxies the model
  APIs and holds credentials server-side.
- **Requirements/permissions:** macOS 14.2+, plus microphone, accessibility, screen-recording,
  and ScreenCaptureKit permissions.

### Original voice/AI stack (v1)

- **STT:** AssemblyAI (streaming transcription)
- **Reasoning + vision:** Anthropic Claude (Sonnet/Opus selectable in the menu)
- **TTS:** ElevenLabs

### Current stack (latest version)

- **Single model:** **OpenAI GPT-Realtime-2.1** (speech-to-speech), replacing the
  AssemblyAI → Claude → ElevenLabs pipeline. See §7 for the architectural implications.

---

## 5. UI/UX Analysis

### The core interaction model

The defining decision is **removing the chat window entirely**. Traditional assistants impose an
"Alt-Tab tax": screenshot → switch to ChatGPT → paste → read → switch back → find the thing.
Clicky collapses that to **hold key, talk, watch the pointer**. Assistance is _in situ_, spatially
anchored to what you're looking at. This is genuinely novel and is the product's entire reason to
exist — reviewers frame it as "a new interface for interacting with AI," not a better chatbot.

### The "buddy" as a character

The pointer isn't a utilitarian crosshair — it's a **friendly blue triangle "buddy"** with
personality-driven motion (the upward-arcing glide). Deliberate emotional design: the
anthropomorphized cursor makes the AI feel like a companion beside you rather than a tool you
query. The name ("buddy"), the cartoon aesthetic, and the follow-you-across-desktops behavior all
reinforce presence and warmth.

### Voice & personality design (underrated UX layer)

The **system prompt is itself a UX artifact.** The model is instructed to speak in
**all-lowercase, casual, warm** tone, "written for the ear, not the eye," and — notably — to
**never end on a dead-end yes/no question.** Instead it must "plant a seed" by suggesting something
more ambitious to try next. That's a retention mechanic baked into the conversational design: every
interaction nudges toward the next. Combined with natural voice output, it feels like a mentor over
your shoulder.

### Friction & onboarding

The softest spot. It needs **mic + accessibility + screen-recording + screen-capture** permissions
and is a menu-bar app, so first-run setup is heavier than the "zero technical setup" marketing
implies. The **freemium** model lets people try the voice/guide loop before hitting the metered
agent wall.

### Where the UX wins

- **No context switching** — help arrives where you already are.
- **Multimodal at once** — it sees (vision), speaks (voice), _and_ gestures (pointing)
  simultaneously. The pointing closes the "which button do you mean?" gap that plain text/voice
  can't.
- **Non-intrusive by default** — click-through overlay, hidden until summoned, hotkey doesn't
  block typing.
- **Multi-monitor aware** — the buddy follows you and prioritizes the active screen.
- **Emotional design** — character + warm voice create attachment a text box can't.

### Where users & reviewers push back

- **Privacy optics.** Constant screen-capture spooks people even though capture is only on-hotkey.
  Repeated asks for a **local-only / on-device** option and "a timed context window, not always-on
  capture." The #1 recurring concern and a real enterprise blocker.
- **It points but doesn't _act_ (in guide mode).** Users want it to **control the mouse** to
  automate multi-step tasks, not just point. (Agent mode partially answers this.)
- **Distraction risk** — a cursor-adjacent, personality-forward presence can pull focus.
- **Shallow skill coverage** — great on mainstream apps (Figma, After Effects, DaVinci Resolve, FL
  Studio) but reviewers want deeper "skill packs" for niche software.
- **Reliability nits** — ElevenLabs getting blocked through the Cloudflare proxy; requests for an
  optional **text response near the cursor** (audio isn't always wanted).
- **Platform risk** — Apple Intelligence's promised on-screen awareness + cross-app Siri could
  commoditize the core feature. Likely moat, per analysts: "personality, speed, and love."

---

## 6. Pricing

- **Free tier** available.
- **Pro — $20/month:** 150 agent messages/month + unlimited voice usage.

---

## 7. Current Stack: OpenAI GPT-Realtime-2.1

The latest version replaces the AssemblyAI → Claude → ElevenLabs pipeline with a single
**OpenAI GPT-Realtime-2.1** speech-to-speech model (OpenAI shipped it ~2026-07-06, plus a cheaper
`-mini`). Relevant capabilities: **text + audio + image input**, **tool/function calling**,
**async function calling**, **configurable reasoning effort**, 128k context, 32k max output.

### The pipeline collapses 3 services → 1

One **persistent streaming session** handles transcription, reasoning, vision, and voice output.
Lower latency, less glue code, one bill, fewer failure points (recall the ElevenLabs-blocked
complaint).

### Pointing gets cleaner, not just ported

Instead of emitting `[POINT:x,y:label:screenN]` text tags and regex-stripping them, define a
**tool** like `point_at(x, y, label, screen)` and let the model call it. **Async function calling**
means the model keeps talking fluidly while the pointer animates. Structured args > parsing
coordinates out of prose.

### Connection model is different — plan for it

This is a **stateful streaming session** (WebRTC for the audio path in a native/desktop client, or
WebSocket), not request/response. The proxy's job changes: it **mints an ephemeral session token**
and the client connects directly to OpenAI, keeping the real API key server-side without putting
the proxy in the hot audio path.

### Vision: push frames on-demand

Feed screenshots as image input **on the hotkey** (Clicky's on-capture model). Don't stream every
frame — images are token-heavy against the 128k context. On-demand capture also happens to answer
Clicky's #1 privacy complaint.

### Trade-offs

- **Lose ElevenLabs' voice range/cloning.** Realtime ships a fixed set of OpenAI voices. If a
  branded voice was part of the "personality" moat, that's a downgrade.
- **Audio tokens aren't cheap.** ~~$32 / $64 per 1M input/output audio tokens on 2.1; realistic
  speech-to-speech runs **~~$0.04/min** with VAD + prompt caching; the **mini** tier cuts it
  further. Cache the system prompt + tool defs (cached audio ~$0.30–0.40/1M) since they resend
  every turn. Image input ~$5/1M. Use `-mini` for the fast point-and-talk loop, reserve full 2.1
  (or higher reasoning effort) for agent mode.
- **Barge-in is free** — native VAD/interruption handling, a real conversational-feel win.
- **Reasoning effort is configurable** — low for snappy guidance, higher for agent tasks.

---

## 8. Landscape Note (naming is crowded)

- **Official product:** **heyclicky.com** (Farza's, Mac; Windows is _waitlist-only_).
- Likely copycats/clones riding the name: `clicky.foo` ("Free AI Assistant for Windows"),
  `clicky-ai.com` ("Push-to-Talk AI Assistant for Chrome"), `clicky-six.vercel.app`.
- **Unrelated:** `clicky.com` is a web-analytics company.

Don't conflate them when researching further.

---

## 9. Transferable Lessons (for a Windows/Mac overlay build)

- The **transparent, click-through, always-on-top, per-monitor overlay window** is the same
  pattern on Windows (layered + topmost + click-through / `WS_EX_TRANSPARENT` equivalents).
- **Draw your own cursor/character; never move the system cursor** — sidesteps a class of pain.
- Their coordinate-transform pain is macOS-specific, but there's a Windows analog (per-monitor DPI
  scaling, virtual-desktop origin). Budget for it.
- Their biggest unresolved UX problem — **privacy of always-visible / screen-capturing overlays**
  — should be designed _around from day one_: explicit capture indicator, on-demand only, local
  option.
- Clicky's **Windows version is waitlist-only** — there's an open lane.
- On GPT-Realtime-2.1, the "point and talk" core gets **simpler and faster**; the main thing given
  up is voice customization, and the main thing to watch is per-minute audio cost.

---

## 10. Sources

- [heyclicky.com](https://www.heyclicky.com/) — official site
- [github.com/farzaa/clicky](https://github.com/farzaa/clicky) — open-source repo
- [How Clicky Works — Isaac Flath](https://isaacflath.com/writing/how-clicky-works) — engineering teardown
- [Product Hunt — Clicky](https://www.producthunt.com/products/clicky-2) — reviews/comments
- [Y Combinator — HeyClicky](https://www.ycombinator.com/companies/heyclicky)
- [DailyDropout — HeyClicky](https://dailydropout.substack.com/p/heyclicky-give-your-cursor-infinite)
- [FunBlocks review](https://www.funblocks.net/aitools/reviews/clicky-2)
- [EveryDev — Hey Clicky](https://www.everydev.ai/tools/hey-clicky)
- [GPT-Realtime-2.1 model docs](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [MarkTechPost — GPT-Realtime-2.1 launch](https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/)
- [OpenAI Realtime API pricing](https://developers.openai.com/api/docs/pricing)
