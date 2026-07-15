# Buddy for Windows — Agent Sandbox Design ("buddies use the computer")

> Design doc. Gives helper buddies (docs/AGENT-MODE.md, shipped M18) a computer of their own to
> act with — an offscreen browser sandbox — governed by an **action-review agent** as the first
> line of defense and **raise-hand** (human approval) as the absolute fallback. Depends on the
> shipped agent runtime (`src/main/agents/`), the Sol computer-use operator
> (`src/main/computer/`), and Codex auth. Read `docs/ARCHITECTURE.md` first; this doc assumes it.

> Posture change, made deliberately: AGENT-MODE §3.2 deferred "mouse-keyboard automation" hard.
> That deferral was about actuating the USER'S live desktop. This design keeps that line intact —
> the live desktop stays behind explicit opt-in computer use (Sol) and, for buddies, behind
> raise-hand — and instead gives buddies their OWN surface to act on: hidden browser windows that
> never touch the user's screen, mouse, keyboard, or focus.

---

## 0. Executive summary

Helper buddies today are read-only (web_search / web_fetch / scratchpad / read_screen). The most
valuable delegated work — "file this Linear ticket", "pull this week's numbers", anything behind a
login — needs a browser the buddy can *drive*. Windows 11 Home offers no OS sandbox (no Windows
Sandbox, no Hyper-V, no RDP host), but Electron gives us something better for this product: a
**per-buddy hidden `BrowserWindow`** on a persistent "buddy work profile" partition, driven
entirely through synthetic input.

```
  buddy loop (Codex Responses, existing)
        │  browser_click{x, y, label, justification}
        ▼
  ActionGate  ── unflagged ──────────────► execute
        │ flagged (DOM hit-test: submit/send/pay/…)
        ▼
  Review agent (one-shot, strict JSON)
        ├─ approve  ──────────────────────► execute
        ├─ deny     ─► tool output {denied, reason}; final. 3 strikes → escalate/halt
        └─ escalate ─► raise-hand: user approves once / always / denies
                         "always" → approval memory (informs future reviews)
```

Five pillars, one line each:

1. **Driver seam**: extract `ComputerDriver` from `operator.ts`; live-desktop and offscreen-browser
   implementations share the gate and the one-action-per-observation loop discipline.
2. **Sandbox**: hidden `BrowserWindow`, `partition: 'persist:buddy'`, input via CDP
   (`webContents.debugger`), capture via `capturePage()` — spike-verified on Electron 43 (§2.2).
3. **Gate**: mechanically unbypassable, placed between tool-call parse and input dispatch; a pure
   DOM-grounded trigger decides what needs review; only flagged actions pay reviewer latency.
4. **Review agent**: judges *is this action a faithful step toward the user's stated task* from
   ground truth (DOM hit-test, form payload, URL) + the buddy's claimed justification.
   Uncertain-alignment → deny (final); uncertain-consequence → escalate.
5. **Approval memory**: user "always allow" grants persist across tasks as normalized action
   signatures. A grant answers the CONSEQUENCE question only — the reviewer's alignment check
   always still runs. Grants are listed and revocable in settings.

Raise-hand stays scarce by design: it fires only on reviewer escalation, repeated denials, CAPTCHAs
/ sign-in walls, and unresolvable hit-tests. When it fires for something visual, the card can show
the buddy's (normally hidden) window so the user acts in place.

---

## 1. The driver seam

`ComputerUseOperator` (src/main/computer/operator.ts) already contains the loop we want —
screenshot → model → single action → settle → fresh screenshot — but hard-wires the live desktop
(`WindowsInputController` + `captureAllDisplays` + DIP mapping). Extract the actuation surface:

```ts
// src/main/computer/driver.ts
export interface ComputerDriver {
  /** Fresh observation of this driver's surface. Same CaptureResult/CaptureMeta shapes as capture.ts. */
  capture(): Promise<CaptureResult[]>;
  /** All coordinates are pixels in the named capture's image space (screenIndex selects it). */
  click(target: DriverPoint, button: MouseButton, count: 1 | 2): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  /** Browser drivers add these; live desktop throws 'unsupported'. */
  navigate?(url: string): Promise<void>;
  scroll?(target: DriverPoint, dy: number): Promise<void>;
  /** Ground truth for the gate. Live desktop returns null (pixels only — every flagged
   *  action there escalates); the browser driver hit-tests the real DOM. */
  inspect(target: DriverPoint): Promise<ElementFacts | null>;
  dispose(): Promise<void>;
}
export interface DriverPoint { screenIndex: number; x: number; y: number }
```

- `LiveDesktopDriver` wraps the existing `WindowsInputController` daemon + `mapModelPoint` +
  `dipToScreenPoint` — behavior byte-identical to today; `operator.ts` becomes a consumer.
- `OffscreenBrowserDriver` is new (§2). One instance per buddy, owned by the agent, torn down by
  the agent's existing `AbortSignal` / terminal transition.
- The **ActionGate (§4) sits inside the driver-consuming execute path**, not in any prompt: parsed
  tool call → gate → (verdict) → driver method. A prompt-injected buddy can *want* anything; the
  click does not physically happen until the gate passes it. One gate, both surfaces.

## 2. The offscreen browser sandbox

### 2.1 Window + partition

```ts
new BrowserWindow({
  show: false,                       // never shown; never steals focus; no taskbar presence
  width: 1024, height: 768, useContentSize: true,
  skipTaskbar: true,
  webPreferences: {
    partition: 'persist:buddy',      // the shared buddy work profile (§2.4)
    backgroundThrottling: false,     // keep timers/paints honest while hidden
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  },
});
```

- One window per buddy → buddies parallelize with zero contention (no shared cursor, no focus).
- `setWindowOpenHandler`: new-window requests navigate the same window (deny popups) — one
  observable surface per buddy, no invisible tab sprawl.
- Downloads: `session.on('will-download', …)` → cancel in v1 (file writes are still deferred per
  AGENT-MODE §3.2). Permission requests (camera/mic/geolocation/notifications): deny all.

### 2.2 Input via CDP — spike-verified

Spike (`tools/spikes/offscreen-browser-spike.js`, run 2026-07-14 on Electron 43.1.0, Windows 11
Home, 150% display) against a `show:false` window that was never shown:

| Mechanism                                            | Result                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `capturePage()` while hidden                         | ✅ real painted pixels (color-sampled), repaints after input |
| CDP click (`Input.dispatchMouseEvent`)               | ✅ with `isVisible()=false`, `isFocused()=false`             |
| CDP typing (`Input.insertText`, `dispatchKeyEvent`)  | ✅ both land                                                 |
| `elementFromPoint` via `executeJavaScript`           | ✅ returns the real element (tag/id/text/form membership)    |
| `sendInputEvent` fallback                            | ⚠️ mouse works; **keyboard does NOT land without OS focus**  |

Decision: **the input path is `webContents.debugger` (CDP)** — built into Electron, no new
dependency, no DevTools banner, works fully hidden. `sendInputEvent` is not used (the keyboard
failure above). Click = `mousePressed`+`mouseReleased`; typing = `Input.insertText` (literal
Unicode, IME-safe); chords/navigation = `Input.dispatchKeyEvent` pairs; scroll =
`dispatchMouseEvent{type:'mouseWheel'}`. The debugger attaches once per window, detaches on
dispose; a `debugger.on('detach')` restart mirrors the snapper-daemon lifecycle discipline.

### 2.3 Capture + coordinates

`capturePage()` returns the image at the display scale factor (spike: an 800×600 CSS window came
back 1200×903 — note the height was NOT exactly 1.5×). Therefore: **never assume the ratio;
compute it per capture** from `image.getSize()` vs `getContentSize()` and emit a standard
`CaptureMeta` so the existing `mapModelPoint` pipeline (§6 of ARCHITECTURE) applies unchanged —
model coordinates are screenshot pixels, the driver maps them to CSS px for CDP. No snapper, no
REST grounding: the browser driver's `inspect()` IS the grounding.

JPEG at the same ≤2048/80% policy as `capture.ts`, labeled `screen0` (a buddy has one surface).
Captured buddy-window frames are the buddy's own surface, not the user's screen — the "capture
only on hotkey" privacy rule is about the USER'S monitors and is untouched by this design.

### 2.4 The buddy work profile (`persist:buddy`)

Chosen posture: **shared persistent partition** — one work profile all buddies share, surviving
restarts. We cannot (and should not) borrow the user's Chrome cookies; instead the user *enrolls*
sites deliberately:

- Settings → "buddy's browser" → **opens a normal VISIBLE window on `persist:buddy`** where the
  user signs into Linear / Notion / Gmail / etc. Close it; buddies now have those sessions hidden.
- The same visible-window mechanism serves raise-hand "act in place" (§6): CAPTCHAs, sign-in
  walls, OAuth consent — buddies never click through any of those themselves.
- Settings lists enrolled sites (cookie domains present in the partition) with per-site "sign out"
  (clear that domain's storage) and a nuclear "clear buddy's browser".
- Blast radius framing: a compromised buddy can act only on sites the user chose to enroll —
  provisioning an assistant's accounts, not handing over an unlocked laptop.

### 2.5 Lifecycle

Window created lazily on the buddy's first browser tool call; destroyed on terminal status
(done/failed/timed_out/cancelled) and on `manager.dispose()`. Wall-clock and step budgets need a
browser-task tier (real web tasks take more than 12 rounds): `MAX_STEPS` 40 and wall clock 10 min
for buddies that were granted browser tools, still bounded, still cancellable at every boundary.

## 3. Browser tools for helper buddies

Registered in the existing `AgentToolSpec` registry — no sub-delegation to Sol; the buddy's own
Codex loop drives its own window. Granted per-task (a research-only buddy gets none). Every acting
tool carries a **required `justification`** parameter (Damon's ruling: always present, evidence
for the gate):

| Tool                | Args (all with `justification: string` — one sentence, why this serves the task) | Gate exposure |
| ------------------- | ------------------------------------------------------------------ | ------------------------ |
| `browser_navigate`  | `url`                                                              | trigger on domain change |
| `browser_click`     | `x, y, label, button?, count?` (pixels in the last screenshot)     | full trigger (§4.2)      |
| `browser_type`      | `text` (into the focused field)                                    | password-field hard deny |
| `browser_press_keys`| `keys[]` (chords; ENTER in a form field is trigger-equivalent to submit) | full trigger      |
| `browser_scroll`    | `x, y, dy`                                                         | never flagged            |
| `browser_screenshot`| —                                                                  | never flagged            |

Loop discipline copied from the operator: **one action per observation** — after every executed
action the driver settles (~350ms), captures fresh, and the image goes back with the tool output.
Extra same-round calls get `{error: 'only one action is allowed per screen observation'}` (same
wire copy as operator.ts). The buddy's system prompt gains a browser section mirroring
`OPERATOR_INSTRUCTIONS` (inspect, act once, never invent hidden state, stop when unclear) plus:
*your justification is read by a reviewer; describe the action honestly and specifically.*

## 4. The action gate (first line of defense)

### 4.1 Placement

`src/main/agents/gate/` — consumed by the tool executors, wrapping every `ComputerDriver` acting
call. Order per action: parse args → `driver.inspect(target)` → trigger (§4.2) → if flagged,
reviewer (§4.3–4.4) → verdict → dispatch or refuse. The gate also journals every assessment
(evidence digest + verdict + reason) to the session journal (§7c of ARCHITECTURE) — a complete
audit trail per buddy.

### 4.2 Trigger layer (pure, unit-tested)

`gate/trigger.ts` — pure function over `ElementFacts` (the same discipline as
`grounding/scoring.ts`):

```ts
export interface ElementFacts {
  tag: string; inputType?: string;         // 'submit' | 'password' | 'file' | …
  text: string;                            // visible label, trimmed/capped
  inForm: boolean; formAction?: string;
  href?: string; url: string;              // page URL at inspect time
  frame: 'top' | 'same-origin' | 'cross-origin-unresolved';
}
export type TriggerVerdict =
  | { kind: 'pass' }                       // execute, no review
  | { kind: 'review'; reasons: string[] }  // reviewer decides
  | { kind: 'hard-deny'; reason: string }; // never executes, never reviewed
```

- **hard-deny** (mechanical, no model in the loop): typing into `input[type=password]` or any
  credential-shaped field; clicks on OAuth consent-grant buttons; anything on `chrome:`/`file:`
  URLs. Credentials and permission grants are the app-wide prohibited category — a buddy never
  does them, the user does (via the visible window, §2.4).
- **review**: `type=submit` / button inside a `<form>`; visible text matching
  send / pay / confirm / delete / post / order / publish / transfer / grant / authorize (and their
  common variants); ENTER while focus is in a form field; file-upload inputs; navigation to a
  domain outside the task's seen-so-far set.
- **`inspect()` mechanics**: `elementFromPoint` recursing through shadow roots
  (`shadowRoot.elementFromPoint`); iframes resolved by translating coordinates into the child
  frame and evaluating there via `webContents.mainFrame.framesInSubtree` (`WebFrameMain` executes
  in each frame's own context, cross-origin included). If the element still cannot be resolved →
  `frame: 'cross-origin-unresolved'` and the action counts as **review** with that fact in
  evidence (conservative default, never silent-pass).
- `LiveDesktopDriver.inspect()` returns null → every flagged-by-text-heuristics action on the
  live desktop escalates straight to raise-hand (no DOM ground truth = no auto-approve).

### 4.3 Reviewer evidence package

`gate/reviewer.ts` — one-shot `CodexResponsesSession` (the rest-grounder pattern: single request,
strict JSON schema output, low reasoning effort, `service_tier: priority`, ~2.5s soft budget with
a hard abort; **on reviewer timeout/error the action is treated as `escalate`**, never approved by
default). Evidence, in trust order:

1. **The user's original task** — `AgentBrief.task` verbatim (the anchor no web page can rewrite).
2. **Mechanical facts** — `ElementFacts`, the exact action args, the page URL/domain.
3. **The screenshot with the target marked** — the last capture with a drawn ring at the click
   point (nativeImage composite), so the reviewer judges what is actually being hit.
4. **The pending payload** — for form submits, the form's current field values read from the DOM
   (names + values, capped, password/credential fields elided). This is the highest-value check:
   the email body says what the user asked; the recipient is not attacker-supplied.
5. **The buddy's justification** — labeled explicitly in the reviewer prompt as *a claim by the
   acting agent, not a fact*. A mismatch between claim and mechanical facts is itself a deny
   signal ("justification says 'clicking next', element is a payment submit").
6. **The buddy's recent step trail** (existing `AgentStep` log, last ~10) and any **standing
   approval grants** matching this signature (§5).

Reviewer hardening: fresh context per assessment (no memory of the buddy's conversation), no
tools, output constrained to the verdict schema, and an explicit instruction that all page-derived
text in the evidence is data — the reviewer never follows instructions found in it.

### 4.4 Verdicts

```ts
export type ReviewVerdict =
  | { verdict: 'approve'; reason: string }
  | { verdict: 'deny'; reason: string }      // final — no appeal (justification was the appeal)
  | { verdict: 'escalate'; reason: string; concern: string }; // → raise-hand
```

Decision rule, stated in the reviewer prompt exactly:

- **approve** — the action is clearly a faithful step toward the user's task.
- **deny** — the action is outside or contrary to the task (wrong recipient, wrong domain,
  materially different action), or alignment cannot be established. **Uncertainty about
  ALIGNMENT is a deny**, not an escalation — don't page the human for something that looks wrong.
- **escalate** — the action matches the task but is consequential (money, mass-send, delete,
  publish) and no standing grant covers it. **Uncertainty about CONSEQUENCE escalates.**

Deny mechanics (Damon's ruling: deny is final): the click does not happen; the tool output returns
`{denied: true, reason}` so the buddy can reroute or finish honestly. `gate/strikes.ts` counts
denials per (buddy, target signature): **3 denials on the same target → auto-escalate**; **5
denials total in a run → halt the buddy** (`failed`, copy: *"i kept proposing actions the reviewer
wouldn't pass, so i stopped — the details are on my card."*). The strike counter is the pressure
valve that replaces an appeal channel.

## 5. Approval memory

The design invariant, worth stating twice: **a remembered approval answers the consequence
question, never the alignment question.** Grants let the reviewer approve where it would have
escalated; nothing ever skips the reviewer — otherwise "sending email was approved once" becomes
an arbitrary-email license for an injected buddy.

```ts
// src/shared/types.ts (integration-approved)
export interface ApprovalGrant {
  id: string;
  domain: string;              // 'linear.app' (registrable domain, not full host)
  actionKind: 'form-submit' | 'button' | 'keyboard-submit' | 'navigation';
  target: string;              // normalized element descriptor: 'create issue'
  createdAt: number; lastUsedAt: number; timesUsed: number;
}
```

- **Signature normalization** (`gate/signature.ts`, pure, unit-tested): lowercase, strip counts
  and ids ("Create issue (3)" → "create issue"), registrable domain via the same logic web-fetch
  uses. Payloads are NEVER part of a signature — the payload is what varies per task and is
  exactly what the reviewer re-checks every time.
- **Granting**: the raise-hand card offers *approve once* / *always allow buddies to <create
  issues on linear.app>* / *deny*. "Always" writes a grant.
- **Within-task follow-through**: a raise-hand approval (either scope) also covers the immediate
  confirmation chain — subsequent flagged actions on the same domain within 60s or 3 actions,
  whichever first, carry the approval into the reviewer's evidence — so a site's "Are you sure?"
  dialog doesn't raise-hand twice for one human decision.
- **Storage**: `AgentPersistencePort` pattern — JSON under userData, tmp+rename, 0o600, validated
  on load, failures non-fatal. Settings → "buddy permissions" lists grants with revoke buttons.
- Grants also downgrade nothing to `pass`: flagged is flagged; the trigger layer never consults
  memory.

## 6. Raise-hand (absolute fallback)

Fires only on: reviewer `escalate`, 3-strike auto-escalate, CAPTCHAs/sign-in walls (detected by
the buddy and reported via a dedicated `needs_user` tool output — buddies never solve bot checks),
and unresolved-element actions on the live desktop. Mechanics:

- New `AgentStatus: 'waiting_approval'`. The buddy parks BETWEEN requests — the `store:false`
  client-side-history loop means nothing is held open over the network; the pending tool output is
  simply not sent until the verdict arrives. Wall clock pauses while parked. Parking is free.
- The card (panel agents view + overlay helper hover card): marked screenshot, the action in plain
  words, the payload digest, the reviewer's specific concern, and the three buttons (§5). For
  CAPTCHAs/sign-in the card adds **"let me do it"** → shows the buddy's hidden window as a normal
  visible window; when the user clicks "done" it hides again and the buddy re-observes.
- Overlay: the buddy's helper sprite raises a tiny hand (amber "?" badge) — same self-dismissing
  sprite system as M19, but a waiting_approval sprite does NOT self-dismiss.
- No response: parked buddies survive indefinitely within the app run; on quit they end
  `cancelled` with copy *"i was waiting on your ok when the app closed."* Tray balloon on
  escalation (same nudge budget discipline as agent completion).
- Voice: if a session is live, Buddy may say one line (*"quick check — the linear buddy wants to
  submit the ticket, ok?"*) via the existing deliverAgentResult idle-turn machinery; never
  interrupts mid-turn.

## 7. Shared types + IPC (integration-approved edits)

`src/shared/types.ts`: `AgentStatus` gains `'waiting_approval'`; `AgentStep['kind']` gains
`'browse' | 'action' | 'review'`; new `ApprovalGrant` (§5) and renderer-safe
`ApprovalRequest { agentId, actionText, concern, screenshotPng: string, payloadDigest: string[] }`.

`src/shared/ipc.ts`:

```ts
// Main → Panel
'panel:approval': ApprovalRequest;              // raise-hand card data
// Renderer → Main (invoke)
'approval:resolve': { args: [agentId: string, verdict: 'once' | 'always' | 'deny']; result: void };
'approval:show-window': { args: [agentId: string]; result: void };  // "let me do it"
'approval:hide-window': { args: [agentId: string]; result: void };  // "done"
'grants:list':   { args: []; result: ApprovalGrant[] };
'grants:revoke': { args: [id: string]; result: void };
'buddy-browser:open-enroll': { args: []; result: void };            // settings sign-in window
```

Screenshot bytes cross to the renderer ONLY inside `ApprovalRequest` (the user must see what they
are approving); everything else stays `AgentSummary`-shaped.

## 8. QA plan

- **Unit (vitest)**: `gate/trigger.ts` (element-fact table → verdicts, incl. password hard-deny,
  ENTER-in-form, cross-origin-unresolved), `gate/signature.ts` normalization, strike counting,
  grant matching, within-task follow-through expiry, capture-ratio math.
- **Driver integration**: an Electron-spawned test (the spike, hardened) run under
  `npm run eval`-style tooling against local `data:`/localhost pages: hidden capture, CDP click,
  insertText, hit-test through shadow DOM and a same-origin iframe.
- **Mock scenarios** (extend `mock-backend.ts` + debug server): clean browse-and-submit with
  auto-approve; a deny → reroute; 3-strike escalate; an escalate → 'always' grant → next run
  auto-approves; a prompt-injected page instructing the buddy to email an attacker (asserts: gate
  denies, journal records it); reviewer timeout → escalate (fail-closed check).
- **Debug server**: `POST /gate/assess` (drive the trigger+reviewer directly),
  `GET /grants`, `POST /agents/:id/approve|deny`.

## 9. Build plan + effort (~13–16 eng-days, three phases)

**Phase A — sandbox + gate-as-escalate (~6d).** Trust arrives before autonomy: every flagged
action raise-hands; no reviewer yet.
- Driver seam extraction from operator.ts (byte-identical live behavior) — 1d
- `OffscreenBrowserDriver` (window/partition/CDP/capture/inspect) — 2d
- Browser tools + loop integration + budgets (§3, §2.5) — 1.5d
- Trigger layer + `waiting_approval` + raise-hand card + IPC — 1.5d

**Phase B — the review agent (~4d).** Escalations become rare.
- Reviewer (evidence assembly, marked screenshot, payload read, strict-JSON call, fail-closed) — 2d
- Deny semantics + strikes + journal audit trail — 1d
- Mock scenarios incl. injection + reviewer-timeout — 1d

**Phase C — approval memory + profile polish (~3.5d).**
- Signatures, grant store, reviewer integration, follow-through window — 1.5d
- Settings: enroll window, enrolled-sites list, grants list/revoke — 1.5d
- Overlay raised-hand sprite state + voice one-liner — 0.5d

## 10. Top risks + mitigations

1. **Prompt injection with a logged-in browser** — the defining risk; a page can steer the buddy.
   _Mitigation_: defense in depth — mechanical trigger grounded in the real DOM (not the buddy's
   claims), a fresh-context tool-less reviewer anchored on the user's verbatim task, deny-is-final
   with strikes, hard-denies for credentials/consent, grants that never bypass review, and a human
   above it all. The injection QA scenario is a release gate.
2. **Sites that fight embedded browsers** — Google sign-in may refuse ("browser may not be
   secure"); bot checks may challenge. _Mitigation_: enrollment happens in the visible window
   (looks/behaves less headless); CAPTCHAs always raise-hand with act-in-place; Google is a
   documented launch limitation if UA adjustments don't clear it. Most SaaS targets (Linear,
   Notion, Stripe) sign in fine.
3. **Reviewer quality drift** (over-approving is a safety failure; over-escalating erodes
   raise-hand scarcity and trains dismissive clicking). _Mitigation_: journaled evidence+verdict
   for every assessment enables an offline eval (the EVAL.md discipline: replay journaled
   assessments against a labeled set); fail-closed on reviewer error; the decision rule is in the
   prompt verbatim so it is testable copy, not vibes.

## 11. Open questions to resolve at build time

1. **Reviewer model/tier** — default plan is `gpt-5.6-sol`, effort low, priority tier (operator's
   config); validate its deny/escalate calibration on the mock scenario set before Phase B ships.
2. **Registrable-domain extraction** — reuse whatever web-fetch settled on vs. a tiny PSL subset;
   grants and trigger domain-checks must agree on one definition.
3. **Payload elision rules** — which form fields are read for evidence vs. elided (password obvious;
   what about card-number-shaped values in arbitrary inputs — likely elide by shape, reuse the
   session-recorder redaction patterns).
4. **Browser-task budgets** — 40 steps / 10 min are guesses; tune against real tasks in Phase A.
5. **Multi-buddy same-site writes** — two buddies acting on one enrolled site concurrently share
   cookies (one login session). Likely fine for v1; revisit if sites fight concurrent sessions.
