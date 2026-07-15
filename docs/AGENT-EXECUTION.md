# Buddy — Agent Filesystem and Shell Execution Design

> Standalone design for a helper buddy's real-filesystem capabilities and shell-shaped execution. Browser
> navigation, computer use, logged-in sessions, action review, and raise-hand approval belong to
> `docs/AGENT-COMPUTER-USE.md` and are deliberately out of scope. Read `docs/ARCHITECTURE.md`
> first.

---

## 0. Decision

Buddy will ship **real filesystem access with common shell commands and Python**. An execution agent
can read, create, edit, rename, move, and delete files inside user-authorized host files and folders.
Changes are committed to the real filesystem during the task; this is not an import/export-only
jail. The capability still does not expose native Bash, PowerShell, arbitrary processes, or paths
outside the user's grants.

The selected implementation is:

1. Task-scoped host filesystem grants created through an explicit picker, optionally reactivated
   from a user-remembered file/folder capability.
2. `just-bash` over a capability-backed copy-on-write filesystem for shell syntax, file operations,
   pipes, redirects, and heredocs.
3. A separate Pyodide worker for Python/data/document code over the same staged filesystem view.
4. A main-process filesystem broker as the only authority that reads host bytes and performs
   complete-file, journaled, crash-recoverable changes in authorized roots.
5. A durable change journal and before-images for conflict detection, recovery, and **Undo**.

Both execution engines run in disposable, node-less, network-denied, sandboxed Electron renderers.
They see stable virtual mount names such as `/files/project`, never a native path, directory handle,
or direct host mount. Reads are capability-checked by main; writes remain staged until the broker
commits them to the corresponding real files.

```
                         main-process FilesystemBroker
                   grants + live reads + staged change sets
                                   │
                         bounded, typed byte protocol
                       ┌───────────┴───────────┐
                       ▼                       ▼
             shell execution host       Python execution host
             just-bash + capability FS  Pyodide worker + MEMFS
             common shell subset         pinned offline packages
                       │                       │
                       └───────────┬───────────┘
                                   ▼
                     conflict-checked host commit
                                   ▼
               real files + change journal → Show / Undo
```

Why this instead of WASIX GNU Bash: the product requirement is “Bash or shell” ergonomics for an
agent, not compatibility with pre-existing GNU Bash programs. `just-bash` is designed for agent
workflows, has a pluggable virtual filesystem and structural execution limits, and includes the useful
text/data commands Buddy needs. Pyodide supplies the document/data runtime. WASIX adds GPL
distribution obligations, an unresolved offline command graph, and undocumented hard resource
controls without changing the user experience. Reconsider WASIX only if faithful GNU Bash process
semantics become a hard product requirement.

The user never sees a terminal, command, working directory, stdout, package, or sandbox. They do see
an honest, native file/folder access prompt when Buddy lacks the required grant, and a concise review
for destructive or unusually broad changes. Routine changes inside an already authorized writable
root proceed without per-file prompts so the agent remains useful.

## 1. Honest capability contract

### 1.1 Supported

- Real read/write access to explicitly authorized host files and folder trees.
- Task-scoped grants and user-remembered capabilities, both visible and revocable.
- Stable virtual mounts under `/files/<grant-name>` that persist across the task's tool calls.
- Common shell syntax: quoting, variables, globs, conditionals, loops, functions, pipelines,
  redirects, command substitution, and heredocs within the parity corpus in §10.
- The fixed `just-bash` command registry selected and tested by Buddy.
- Offline Python with the standard library and a build-time allowlist of pinned, tested packages.
- Complete-file publication, journaled multi-file recovery, conflict detection, a durable change
  summary, and bounded Undo recovery. APFS may use atomic exchange; NTFS uses the documented
  journaled handle-relative swap in §5.1.
- Saving new files into any writable authorized folder, including new subdirectories.

### 1.2 Not supported

- GNU Bash/Linux compatibility as a blanket claim; job control, signals, traps, daemons, and
  arbitrary installed binaries are outside the promise unless explicitly added to the corpus.
- Native Bash, PowerShell, `cmd.exe`, WSL, Terminal, AppleScript, system Python/Node, or any call to
  `child_process`, `exec`, `spawn`, or a native shell.
- Paths outside explicit grants; raw native paths or directory handles in the model/renderer;
  browser profiles, app settings, environment variables, keychains, devices, pipes, sockets,
  clipboard, or credentials.
- Runtime package installation, CDN/registry access, online `pip`/npm, host callbacks, or a
  user-grantable network capability.
- Browser/computer-use tools in the same capability set. Combining the two later requires a new
  threat model because it creates an exfiltration path.

Execution isolation does not make the agent loop fully local. For an approved folder-disclosure
scope, filenames, directory listings, any non-excluded file content in that whole tree, and bounded
shell/Python output may be processed by Buddy's configured model provider while completing the task.
For an exact-file scope, only that file is eligible. UX must state that truth and must never imply
that a private mount is fully on-device. The execution buddy receives no hosted web search,
`web_fetch`, `read_screen`,
browser, or computer-use tools, so file-derived text cannot be deliberately routed to an arbitrary
external destination. A future local-only promise requires an on-device planning model and a
separate design.

The shell surface may author source in any language, but only explicitly shipped engines execute.
Writing `program.rb` is harmless; `ruby program.rb` returns command-not-found unless a reviewed
Ruby runtime is deliberately added in a future full-image update.

## 2. User experience

### 2.1 Inputs

The whisper composer gains **Add files** and **Add folder**. V1 deliberately does not expose
drag/drop because the current whisper hides on blur and cannot remain a reliable drop target while
the user is in Finder/Explorer. Opening a native picker increments a main-owned interaction hold;
blur cannot hide the whisper until the picker resolves.

After every picker selection, one canonical focusable confirmation sheet shows the exact item,
named provider/account, and two separate facts: local filesystem authority and provider disclosure.
For a folder, the user chooses **View only** or **Allow changes**; the latter states that Buddy may
create, replace, move, and recoverably remove descendants. An exact-file selection starts View-only
and offers **Allow changes to this file**. That action has the user authorize the containing folder
through the native picker solely to create a `WritableEntryCapability`: Buddy may replace the exact
selected entry using broker-derived sibling temporaries/backups but cannot list, read, create, or
rename siblings. Provider disclosure remains `exact-file-content`. A full writable folder grant is a
separate explicit choice for folder-wide work. For a folder, the sheet states that
the named AI service may receive names and content from any non-excluded file in that tree while
working—not just the file Buddy eventually changes. An unchecked **Remember this file/folder**
toggle is optional. One **Continue** activates both task-scoped records; **Cancel** grants neither and
returns to the editable brief. The provider disclosure is reconfirmed whenever the provider/account
or task changes.

Every confirmed item becomes a capability chip showing its exact display name and access level:
**Can view** or **Can change**. Activating a chip reopens the same sheet so the user can change or
remove it before submission; changing it invalidates the earlier task disclosure and requires
**Continue** again. A file chip authorizes only that file and distinguishes **Can view** from
**Can change this file**. A folder grant authorizes its current and future descendants but never its
parent or siblings. Creating or moving a result into a folder therefore requires a writable folder
grant, not merely an entry capability. Chips
belong to the next submitted typed or spoken task and clear only after the task successfully spawns.
Replacing the selected file may use `WritableEntryCapability`; renaming it requires a full writable
parent-folder grant. A folder grant never authorizes renaming/moving that top-level folder itself.

The native picker is the only ordinary path-acquisition flow. The model may ask for “the project
folder,” but it cannot invent, enumerate, or authorize a native path. If a voice task lacks access,
Buddy retains exactly one pending editable brief, opens the appropriate picker, and says one short
line such as “choose the folder you want me to change.” A valid selection opens the canonical sheet;
only its local **Continue** button resumes and spawns that brief. Cancel returns to the same brief and
preserves existing grants.

The composer also offers **Add from remembered access**. A dedicated network-denied, local-only File
Access window shows full path, friendly label, access level, and last use before any provider call.
Its display-path value is not accepted back as authority; selection returns only the row's opaque,
main-bound nonce. Duplicate names are never guessed. For voice, one unambiguous match is shown
locally while fixed copy asks “Use the selected folder?”; multiple matches open this chooser. No name
is spoken through Realtime before disclosure. Selection then performs the task-scoped provider/scope
reconfirmation.

### 2.2 Grant lifetime and management

Grants are least-authority but fully functional:

- **For this task** is the default. It is revoked at terminal task state and cannot be reused by a
  later agent.
- **Remember this file/folder** is an optional unchecked secondary action in the grant sheet. It
  creates a persistent bookmark/capability, not a remembered path string. Persistent grants appear
  in Settings → File access with exact scope, item kind, access level, last use, **Change access**,
  and **Remove**. A remembered exact file reopens as the non-enumerable `EntryCapability` from §5.2;
  one separately confirmed for editing reopens as `WritableEntryCapability`. After Buddy itself
  successfully replaces the bound file, the same journaled commit atomically rotates the writable
  capability to the broker-verified new identity. External replacement, disappearance,
  parent-identity change, or movement to a denied ancestry invalidates either form instead of
  silently attaching to a same-named entry.
- Remembered access removes repeated picking; it is not standing authorization for background work.
  Every use still requires a current user task whose target falls within that exact scope.
- Whole-home, filesystem-root, removable, network, and cloud-synced grants do not ship until their
  exact filesystem passes the same identity, atomic-replace, crash-recovery, and Undo corpus as local
  fixed APFS/NTFS storage.
- Protected OS locations, another user's profile, Buddy's application/support data, browser
  profiles, credential stores, Trash/Recycle Bin, and filesystem/device roots are never grantable.

Renaming or moving a granted root invalidates it unless the platform capability follows the same
file identity and its current ancestry still passes every protected-location and ownership rule.
That ancestry is revalidated on every activation and broker operation; moving the same identity into
a denied tree makes the grant unusable. Before commit, revocation immediately destroys execution
hosts, cancels reads, invalidates tokens, and discards staging. Once commit crosses the journaled
recovery barrier, revocation blocks all new authority but the broker retains only the exact handles,
WAL, before-images, and recovery capability required to resolve `committed`, `rolled_back`, or
`indeterminate`; it then closes them. Already disclosed provider bytes cannot be recalled, and the UI
says so plainly. Choosing another scope starts a fresh task, transaction, disclosure, and model
context; staged operations or reasoning are never rebound. Buddy never silently broadens to an
ancestor.

At commit, the task grant is replaced—not silently retained—by a visibly disclosed
`RecoveryCapability` bound only to that transaction's exact committed file identities and permitted
actions: Show, safe Open, Review, Undo, and broker-derived export of the exact preserved version set
only for an Undo conflict or `indeterminate` reconciliation. Exports use noncolliding names below the
separately user-authorized `Buddy Output/Recovered` capability. It cannot list the original folder, read
unrelated bytes, create any other path, or authorize another task. For an
ordinary committed transaction it expires with the 30-day recovery record and can be removed early
through Recent Work; removing it also ends Undo after explicit confirmation. An `indeterminate`
recovery capability follows the non-expiring resolution contract in §2.5 instead.

### 2.3 Provider disclosure is a separate task capability

A filesystem grant authorizes local reads/writes; it does not itself authorize sending names or
content to a model provider. Every filesystem task has a separate task-scoped disclosure record
bound to the selected provider/account, exact grants, and explicit `exact-file-content` or
`whole-tree-names-and-content` scope. The confirmation sheet presents the two
facts separately—what Buddy may change locally and what content the named AI service may receive—and
one **Continue** gesture activates both for that task. Remembering a folder never remembers provider
disclosure; using it later reconfirms provider and scope before any name, listing, or content leaves
the device.

That gesture binds a hash of the immutable submitted brief: exact task text, ordered attachments,
access roles, provider/account, grants, and disclosure scopes. Editing, replacing, adding, removing,
or reordering any element invalidates both task-scoped records and reopens confirmation. The model
cannot reinterpret a confirmed brief into broader filesystem authority.

If disclosure is declined, the current remote-planned filesystem agent does not start. A future
on-device planner may run locally, but its tools may return only fixed status/count/hash metadata;
filenames, contents, directory listings, data-bearing scripts, stdout/stderr, manifests, and derived
values remain local. No interface calls that mode “private” unless packet-capture tests prove the
complete planner/runtime path is local.

### 2.4 Working state

The helper shows human checkpoints—“reading Project,” “updating three files,” “checking the changes,”
“saving them”—never scripts or terminal output. Stop remains available throughout reads, execution,
validation, and pre-commit staging. If Stop arrives during the journaled commit phase, the UI says
“finishing a safe stopping point”; the recovery barrier resolves to `committed`, `rolled_back`, or
`indeterminate`. Indeterminate takes precedence over cancelled and opens the critical recovery flow.

A writable grant plus the user's task is consent for routine in-scope changes. There is no redundant
**Apply changes** prompt at the end of every task. Safety comes from narrow roots, staged atomic
commits, deterministic hard limits, Trash-only deletion, before-images, conflict checks, and Undo—not
from asking a nontechnical user to approve model-generated commands.

“Routine” is intentionally narrower for folders: new noncolliding files may auto-commit, but changing
an existing file discovered through a folder requires the exact review unless that file was also
mechanically selected as an edit target before the task. The writable-folder sheet states: “New files
can be saved automatically; I'll show you existing-file changes before making them.”

The agent stages one coherent change set. Before committing, main revalidates every source/root
identity and enforces the task limits. A change set exceeding the fixed file/byte/destructive limits
does not offer “allow anyway”; Buddy asks the user to narrow the task. If another app changed a target
after Buddy read it, preflight reports a conflict; a later replace race follows the preserve-and-
restore contract in §5.3 and never silently loses displaced bytes.

### 2.5 Results and recovery in Buddy's current no-panel UI

Mutation completion means the real filesystem commit and durable undo journal both succeeded. The
expanded overlay helper announces “Changed 4 files in Project” or “Created report.csv in Reports.” It
never says done while bytes exist only in staging. A verified empty-manifest read/analysis task uses
the distinct local-answer lifecycle below and creates no commit, Undo, or recovery metadata.

The overlay remains non-focusable and contains no keyboard controls. Its pointer-only result
affordance opens a separate durable, focusable results window. The whisper contains a tab-focusable
**Results** button whenever a filesystem result is unresolved, and the tray/menu-bar menu contains
**Recent Work…**. All use the same typed `results:show` IPC. For ordinary transactions, recovery/Undo
bytes persist for 30 days and renderer-safe history metadata persists for 37 days, making the
**Undo expired** state visible for the final seven days. Indeterminate records follow the separate
non-expiring contract below. Dismiss clears notification/unresolved state only; it never removes an
ordinary transaction from Recent Work before its metadata expiry.

Renderer-safe change metadata is added to `AgentSummary`; absolute paths, capabilities, before-image
bytes, file contents, scripts, and stdout never cross through that summary or an ordinary renderer
broadcast. The results window shows exact
root labels and relative paths grouped as **Created**, **Edited**, **Moved**, and **Removed**. A
removed item says **Moved to Trash** only when that post-commit transfer was verified; otherwise it
says **Removed from folder — Undo available**.

A no-mutation read/analysis task has a separate `LocalFilesystemAnswer`, never an `AgentSummary`
field or renderer broadcast. After main recomputes an empty frozen manifest, it creates one
`awaiting_local_answer` slot bound to `{taskId, runnerGeneration, transactionGeneration,
providerResponseId, windowNonce}`. It atomically accepts exactly one bounded final assistant text only
while that task/generation is current, strips controls, and stores it in a user-only in-memory answer
store. Cancel, teardown, mutation, wrong binding, or pre-delivery close consumes the slot and discards
late text.

Delivery uses a fresh one-shot sandboxed renderer and ephemeral partition with context isolation,
no preload/IPC API, Node, storage, network, navigation, reload, popups, downloads, permissions,
external protocols, clipboard, accessibility/speech forwarding, or links; main inserts the hostile
plain text with `textContent` before showing the exact bound frame. The answer is never forwarded to
Realtime, another agent, browser/computer use, Open, logs, persisted history, notifications, or
speech. Ordinary window close destroys the renderer but retains the answer only in memory so the
unresolved **Results** affordance can reopen it during the same app session. A separate trusted,
session-memory-only Results row carries only an opaque answer ID and fixed “Local answer available”
status; it and its unresolved flag are excluded from recent-work serialization. **Dismiss and delete**
atomically removes the row/flag and erases the bytes. Confirmed app quit does the same, and restart
never reconstructs a stale row. Before any screen-capture,
browser, or live-desktop capability starts, main synchronously destroys all answer renderers; they
cannot reopen until that capability ends. Mutation tasks use only fixed-schema result copy.

Its semantic actions are:

- **Show in folder** for committed files still present at a user-visible destination.
- **Open Trash** only for a removal whose transfer to OS Trash was verified; a private-quarantine
  removal offers Undo but no Show/Open action.
- **Open** for a committed file whose canonical content profile permits OS launch.
- **Undo changes** while the recovery journal is retained.
- **Review** for a bounded text diff or safe canonical preview.
- **Dismiss**, which removes only the result card and never deletes a real file or recovery record.

V1 action policy is fixed:

| Committed result                                               | Actions                              |
| -------------------------------------------------------------- | ------------------------------------ |
| Canonical `.txt`, `.json`, neutralized `.csv`, PNG, JPEG       | Safe Review + Open + Show            |
| Markdown, source, shell, build/configuration text              | Escaped Review + Show; never OS Open |
| Existing opaque file moved/copied without parsing              | Show destination only                |
| Removal verified in OS Trash                                   | Open Trash + Undo                    |
| Removal retained in broker-private quarantine                  | Undo only; no Show/Preview/Open      |
| Unsupported, active, executable, shortcut, installer, polyglot | No content commit or Open            |

An `indeterminate` result is critical, persistent, and non-dismissible until successfully resolved.
It has no automatic retention expiry: the affected-root block, audit record, recovery capability,
and every preserved copy survive restarts until reconciliation. Storage pressure may refuse later
mutations but never evicts these bytes or silently clears the block. Startup,
tray/menu-bar, and whisper show the affected root locally without stealing focus. The next voice turn
uses fixed count/status-only copy—“Some files need review; open Recent Work”—and sends no name or root
label to Realtime.
Recent Work shows every affected relative path, all preserved/recovered copies, and **Show copies** /
**Review files** / **Export preserved copies** / **Mark resolved** actions. Export uses the exact
transaction-bound preserved set and deterministic noncolliding names under `Buddy Output/Recovered`; it
cannot select another source or destination. New mutations to that root remain blocked. Mark resolved
requires a successful broker recheck plus concrete acknowledgement that the user reviewed or exported
the named versions. When any version is opaque, active, quarantined, or otherwise lacks safe Review/
Show, successful export and verification are mandatory before Mark resolved enables. Only then is the
root block removed; the record remains as resolved audit metadata and its preserved copies begin a new
disclosed 30-day deletion window.

Undo is itself a conflict-checked transaction. It restores before-images and reverses moves only if
the current file still matches Buddy's committed hash; otherwise it leaves the newer file untouched
and explains which items need manual attention. Undo records are guaranteed for 30 days. If the
bounded user-only undo vault lacks room, the original task is refused before mutation
rather than committed without recovery.

When Undo must preserve newer work, the earlier version is restored under the exact broker-derived
name `Buddy Output/Recovered/<name> (recovered <date>).<ext>` with collision suffixing. The
result links to that copy; recovery never regains namespace authority in the original folder.

A preflight conflict leaves the entire coherent transaction uncommitted. The conflict window lists
every stale relative path and offers **Run again using the newest files**, which destroys staging and
starts a fresh transaction over all current inputs; **Save Buddy's versions as copies**, which shows
the exact noncolliding names below the create-only `Buddy Output/Recovered` capability and commits only
those new files after normal classification;
and **Cancel**. There is no per-file force overwrite or silent merge. Locked files use the same flow
after bounded retry and never cause Buddy to kill another app. Conflicts appear beside reviews in the
durable **Pending File Work** queue. Closing a conflict window leaves staging pending and discoverable
while Buddy runs; it never strands or implicitly resolves the task.

Grant/disclosure, review, conflict, Recent Work, and Undo surfaces use semantic controls, visible
focus, and complete tab order. V1 voice may open or read fixed non-data-bearing status, but it cannot
authorize a grant, provider disclosure, host commit, conflict action, or Undo: the user activates the
focusable UI's explicit button. Remote Realtime/model transcription is never an approval input and
cannot mint a nonce. A future hotkey yes/no path requires a local deterministic recognizer with
authenticated mic/hotkey provenance, constrained grammar, confidence/ambiguity rejection, and a
separate release gate. “Undo that” opens the named local transaction and focuses **Undo changes**.
Accessibility tests cover keyboard-only, screen reader, voice ambiguity, double activation, stale
nonce, and window-close behavior.

Before the first mutation or recovery record, Buddy requires a persistent **Buddy Output & Recovery**
folder selected through the native folder picker/Powerbox. The picker may suggest a newly created
“From Buddy” folder, and accepts only a newly created or verified-empty dedicated folder—not an
existing general-purpose directory. Neither main nor the broker assumes Documents access or creates
the folder without that gesture. The sheet states that ordinary deliverables may be selected again in
later tasks, while its reserved recovery area is never available to agents. Settings shows the exact
selected folder and **Change** / **Remove**; removing it blocks
new mutations until another exact folder is selected and does not discard existing recovery bytes.
Changing the root affects only future outputs/exports and never moves or deletes files already
exported to an older root. An Undo conflict or indeterminate action that needs a recovered copy pauses
before mutation and asks for/reconfirms the current exact root; cancel/failure leaves Undo or Mark
resolved pending, vault bytes intact, and every affected-root block in place. Changing/removing the
root during active work follows the pre-commit revocation or non-abortable commit-barrier contract in
§2.2.

When a task creates a new deliverable without naming a destination, Buddy uses that separately
user-authorized output root and a noncolliding name. If the user names any other folder, Buddy
requires that exact writable grant before working. The corresponding
`FromBuddyOutputCapability` is create-only, non-enumerable, non-readable except for validating bytes
created by the current transaction, and restricted to broker-derived noncolliding basenames.
`Recovered/` below the same exact root is reserved for transaction-bound recovery exports. Routing
attaches the capability explicitly; it appears in disclosure/audit as “Buddy Output,” never as
ambient Documents authority.

Ordinary deliverables below Buddy Output may later receive fresh `EntryCapability`,
`WritableEntryCapability`, or folder grants with normal task/provider disclosure. Only the reserved
`Recovered/` subtree plus broker metadata/quarantine are protected from every ordinary task grant. If
an ordinary grant is an ancestor, the broker mechanically subtracts those protected identities from
list/stat/read/write/glob traversal and provider disclosure before returning even their names; direct
or descendant grants are rejected. Exclusions for the current and historical recovery roots follow
stable identity across rename and remain until their last recovery record expires/resolves. They are
rechecked on picker selection, remembered-grant activation, and every broker operation.

Viewing a result clears its notification-only `unseen` bit; it does not resolve the result. The
island indicator, helper persistence, and `+N` count use a separate `unresolvedFilesystemResult`
state until Dismiss or, for an ordinary result, the metadata-retention window ends. Indeterminate
state clears only through successful resolution.

## 3. Model-facing tools and commit authority

V1 exposes three tools only to filesystem-execution tasks:

```ts
interface ShellExecArgs {
  script: string;
  /** Virtual POSIX path below an authorized /files mount. */
  cwd?: string;
}

interface PythonExecArgs {
  /** Virtual POSIX .py path in the staged filesystem view. */
  entrypoint: string;
  /** Exact bounded files/directories snapshotted into MEMFS for this run. */
  workingSet: Array<{ path: string; access: 'read' | 'read-write' }>;
  args?: Array<string | number | boolean | null>;
}

type FinishFilesystemTaskArgs = Record<string, never>;
```

`shell_exec` is a virtual shell, not the host shell. It returns exit code, capped/sanitized
stdout/stderr, truncation flags, and a bounded changed-file manifest. Each call gets fresh shell
state, so cwd is explicit; the task's filesystem overlay persists across calls. Reads under
`/files/<grant>` are served lazily through the capability broker. Writes, renames, and removals update
only the staged transaction. `rm` means “stage a recoverable removal,” never unlink.

`python_exec` freezes the current transaction generation, resolves the declared `workingSet` through
quota-charged traversal, snapshots those exact overlay files into Pyodide MEMFS, runs the entrypoint,
and returns changes only below declared `read-write` entries. Merge succeeds only if the transaction
generation is still current. Pyodide cannot lazily open undeclared host files, commit, or resolve a
host path. Shell never calls Python through a host callback: the buddy writes a `.py` file with a
heredoc and invokes `python_exec` explicitly.

`finish_filesystem_task` freezes the proposed operation manifest. It accepts no summary or other
data-bearing argument. Main—not the model—recomputes the diff from the overlay, classifies review
gates, validates output types, preflights recovery capacity, and either commits routine work or moves
the agent to `waiting_approval` with an immutable concrete change preview. Main also constructs all
user-facing result copy from fixed schemas; model final text is discarded and cannot authorize paths,
lower a review class, select a destination, commit bytes, or become a handoff channel. The sole
exception is one post-finish, bounded read-only answer routed into `LocalFilesystemAnswer` under the
local-only contract in §2.5; it still has no authorization or forwarding effect.

Main maintains a monotonic transaction-level `consumedGrantIds` set for every successful or failed
list/stat/read and propagates it through shell/Python snapshots and derived writes. The runtime cannot
clear or relabel lineage. A write to grant D after consuming any grant other than D is conservatively
cross-grant and requires Review, including `cat A > B`, transformed Python output, and content that no
longer byte-matches its source. Direct copy/move additionally uses the broker's two-capability
operation so both authorities and versions are explicit.

The classifier is total and cumulative across every tool call. Predicates use strict
`Refuse > Review > Auto` precedence, so a protected/path-role/content match can never be downgraded by
an Auto or fallback rule. “Ordinary” formally excludes every protected, hidden/configuration,
execution/autoload, special, unsupported-content, cross-grant, and over-quota class. Unmatched
operations default to Review; ambiguity involving any Refuse predicate is Refused, and anything the
review UI cannot represent exactly is Refused.

| Operation/scope                                                                                                               | Classification                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Read/list/stat only                                                                                                           | Auto; no commit                                   |
| Create 1–10 noncolliding ordinary regular files in one writable grant                                                         | Auto                                              |
| Replace 1–10 ordinary regular files mechanically selected as edit targets                                                     | Auto                                              |
| Create or selected-file replace above 10 but below hard task quotas                                                           | Review                                            |
| Replace any existing file not mechanically selected as an edit target                                                         | Review                                            |
| Rename or move any existing descendant, including 1–10 items                                                                  | Review                                            |
| Any destination write after the transaction consumed a different grant; explicit cross-grant copy/move                        | Review                                            |
| Recoverable removal of any item                                                                                               | Review                                            |
| Create/replace/move into a known execution, autoload, build, CI, IDE, package lifecycle, or hidden configuration role         | Review or Refuse per the fixed path-role registry |
| Rename/move a granted top-level root; permanent delete; conflict overwrite; root escape; protected/special file; quota breach | Refuse                                            |

The path-role registry includes `.github/workflows`, `.devcontainer`, `.vscode`/`.idea` task/launch
configuration, package-manager manifests and lifecycle config, build/test hooks, Docker/Compose
entrypoints, `sitecustomize.py`, `.pth`, startup/login locations, shell profiles, Git hooks, Office
templates/macros, browser/IDE extensions, and equivalent platform roles. Unrecognized hidden or
configuration execution surfaces default to Review; executable/shortcut/installer/persistence
payloads remain Refused. Classification is based on broker-normalized destination role and content,
never the model's explanation.

Review approval binds the exact transaction generation, ordered operations, before/after hashes,
root identities, and one-time nonce. A changed manifest requires a new review. Only the trusted
focusable review window can resolve the nonce in V1; model text, tool output, Realtime transcripts,
notifications, and overlay clicks cannot approve.

The focusable review window groups exact relative paths under Create/Replace/Rename/Move/Remove,
shows bounded text diffs or canonical previews, explains autoload/execution roles, and offers
tab-focusable **Make these changes** and **Don't make changes**. Don't discards staging and ends the
task with no host mutation. The non-focusable overlay only announces that file work is waiting; the
whisper **Pending File Work** button and tray/menu-bar **Pending File Work…** open a durable queue of
reviews and conflicts ordered oldest-first.
Multiple waiting tasks never steal focus. Closing the review window leaves them staged and
discoverable while Buddy remains running. A graceful tray/menu **Quit** with any working, review,
conflict, or unresolved local-answer task opens “Quit and discard N pending file tasks and delete M
local answers?” with **Keep Buddy open** as the default and explicit **Quit, discard, and delete**.
Confirmed quit cancels all pre-commit work, discards staging, and erases every in-memory answer/row.
Forced OS termination performs the same discard on recovery and shows “The pending file changes were
cancelled; no files were changed” on next launch. A transaction already past the commit barrier is
recovered instead of discarded.

Tools exist only when the brief has explicit filesystem grants and `executionEnabled`. A filesystem
run never receives hosted `web_search`, `web_fetch`, `read_screen`, browser, or computer-use tools.
The transaction and all grants are revoked on completion, cancel, brief replacement, or teardown.

Constructing a filesystem-mode runner taints that task and its conversation segment before any
provider request or broker operation, even if the first operation fails or only returns metadata.
Every grant-derived success, failure, stat, existence/collision result, size, timestamp, identity,
path, content, tool result, and derived value stays behind the same boundary. The only continuation
out is a fixed non-data-bearing enum/count status constructed by main; filenames, root labels,
summaries, diffs, stdout, model messages, and prior tool context are not forwarded to Realtime,
parent, browser, computer-use, connector, send, or upload agents. A later browser/computer-use run
starts with a fresh context that excludes the tainted segment. Crossing that boundary requires a
future explicit payload/destination information-flow design, not ordinary follow-up text.
`LocalFilesystemAnswer` remains inside this tainted filesystem domain in its isolated local window;
it is not a continuation or handoff out.

## 4. Execution hosts

### 4.1 Process boundary

`src/main/filesystem/` owns grants, the host broker, transactions, journal, recovery, and native
platform seam. `src/main/execution/` owns only disposable virtual-shell/Python hosts; adapter tools
live under `src/main/agents/tools/`. Each execution call receives a fresh hidden `BrowserWindow` with
a unique ephemeral partition and renderer PID:

```ts
new BrowserWindow({
  show: false,
  skipTaskbar: true,
  webPreferences: {
    partition: `buddy-exec:${jobId}`,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: false,
    preload: EXECUTION_PRELOAD,
  },
});
```

The execution page is a packaged controller only. No remote/user HTML loads. The preload exposes a
one-job typed transport, not Electron/Node/filesystem/window APIs. Main treats the renderer as
compromised. It accepts only bounded chunks, validated virtual relative paths, opaque grant IDs, and
transaction tokens; the renderer never receives a native path, OS handle, bookmark, or direct mount.

Each message binds exact `webContents`, main-frame identity, job ID, unguessable nonce, and renderer
generation. Main rejects duplicate, late, wrong-sender, stale-generation, malformed, out-of-order,
or oversized messages. The protocol uses sequenced `MessagePort` chunks with credit/backpressure;
quotas are charged before allocation, structured clone, decompression, or buffering. Stdout/stderr
are continuously drained so an output cap cannot deadlock the guest.

### 4.2 Shell host

- Lock `just-bash` and all transitive dependencies. Implement Buddy's own `CapabilityOverlayFs`
  against the authenticated broker protocol. Do not use upstream `ReadWriteFs` or `OverlayFs`, which
  take host paths and Node authority.
- Pin a reviewed Buddy fork/patch that removes whole-tree `getAllPaths()` collection from
  enumeration/glob expansion. Replace it with quota-charged paginated async `readDir` traversal that
  composes host entries, staged additions, moves, and tombstones without materializing an unbounded
  tree. Audit every synchronous consumer, including `ls` and glob handling; sync IPC and watcher-fed
  namespace caches are forbidden. Each command receives a broker revision, reads its own staged
  writes, and revalidates host versions before the frozen commit.
- The base layer exposes capability-checked read/list/stat for authorized virtual mounts; the upper
  layer is transaction-local copy-on-write. No shell operation writes the host directly. A
  compromised renderer can at most exercise the task's read grants and bounded staging quota; it
  cannot commit, widen a grant, or approve a review.
- Do not enable network config/curl, JavaScript, built-in Python, arbitrary custom commands, real
  directory mounts, or host callbacks other than the exact capability filesystem transport.
- Set all parser, heredoc, expansion, command, loop, recursion, glob, regex, FD, string, array, and
  output limits below Buddy's outer quotas.
- Run inside the node-less Chromium sandbox because `just-bash` explicitly is not VM isolation. If
  an interpreter bug obtains arbitrary renderer JS, it still has no Node, network, privileged
  preload, persistent storage, or host mount.
- Promise only the tested shell corpus. Intentional differences from GNU Bash are documented for
  model prompting/evals, not exposed to ordinary users.

### 4.3 Python host

- Run Pyodide in a dedicated module Worker inside a separate sandboxed execution window. Python's
  `js` bridge reaches a worker global, so it is not a security boundary; the outer renderer/network
  policy remains authoritative.
- Hydrate only the immutable declared working-set snapshot from the current overlay into MEMFS;
  merge the returned diff back into staging only if its transaction generation is current and after
  independent path/quota validation. Never use NODEFS/IDBFS or mount a host/grant directory.
- Vendor exact Pyodide runtime/stdlib/wheels and verify source-committed hashes before every load.
  No CDN fallback, `micropip`, remote `loadPackage`, workspace wheel, dynamic WASM, NODEFS/IDBFS,
  `ctypes`, or system interpreter fallback.
- Candidate packages (`pandas`, `openpyxl`, `python-docx`, `python-pptx` and dependencies) enter the
  image only after offline create/read/write compatibility, license, size, and adversarial-file
  tests pass. The product promise is the frozen tested manifest, not “anything pip can install.”

### 4.4 Network absent twice

The execution sessions are distinct from `persist:buddy`; they have no cookies/storage. Before the
page loads, main calls `session.enableNetworkEmulation({ offline: true })` and installs deny-all
permission check/request handlers, navigation/new-window/download denial, external-protocol denial,
and cancel-all `webRequest` handling. The custom origin serves only the fixed controller, bundled
`just-bash`, and fixed worker scripts; its protocol handler canonicalizes once, allowlists
GET/host/path against a source-committed manifest, never maps URL text to a host path, and does not
grant CSP bypass, fetch support, file access, or service workers.

Pyodide WASM, stdlib, and wheel bytes never use `fetch` or a URL loader. Main reads the signed-app
assets, checks the source-committed hash/size manifest, then transfers bounded `ArrayBuffer` chunks
over the authenticated execution port before untrusted code starts. The worker initializes from
those buffers only. The page's enforced CSP is
`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none';
webrtc 'block'`; the pinned Electron/Chromium build must prove it recognizes and enforces the CSP3
WebRTC directive. The renderer has no code path that accepts or constructs a remote URL.

The offline session, request cancellation, `connect-src 'none'`, and `webrtc 'block'` are independent
mechanisms. Together they deny WebRTC/ICE/STUN/mDNS, WebTransport/QUIC, prefetch, beacon/ping,
WebSocket, EventSource, fetch/XHR, DNS, loopback/LAN/link-local/metadata access, popups, downloads,
permissions, clipboard, and external protocols. Startup probes assert each policy before execution;
OS packet capture verifies the mechanism but is not itself the enforcement. If the pinned Chromium
build cannot enforce `webrtc 'block'` for documents and workers, execution does not ship on that
build.

### 4.5 Cancellation and resources

Main owns cancellation. Stop, timeout, sleep, crash, quota breach, confirmed/forced app quit, or an
unresponsive host destroys the entire dedicated renderer and workers; graceful quit first uses the
pending-work confirmation in §3. No automatic retry runs the same untrusted job.
Before commit, staging is discarded and host files remain unchanged. During commit, the transaction
enters `stopping` and the non-abortable recovery barrier resolves to `committed`, `rolled_back`, or
`indeterminate`. Only rolled back may become cancelled; committed reports the completed change, and
indeterminate takes precedence and opens the critical recovery result. App startup recovers every
incomplete journal before new filesystem agents can start.

Hard limits cover script/input bytes, wall/CPU time, global concurrency, renderer/WASM memory,
workers, files/nodes, per-file/transaction bytes, directory reads, depth, stdout/stderr, IPC,
operations, recovery bytes, archive/parser expansion, and total persisted disk. Limits must apply
before allocation. `just-bash`'s structural
limits help but its own threat model lists a total memory ceiling as future work; Pyodide can also
allocate aggressively. Shipping is blocked until the packaged app demonstrates enforceable memory
ceilings and renderer/worker termination within one second without harming main/audio/overlay.
Polling after allocation is not sufficient.

## 5. Host filesystem broker and transactions

### 5.1 Native capability seam

Node's path-based `fs` API cannot implement the required handle-relative/no-follow contract on both
platforms. Buddy therefore packages a small signed first-party `buddy-file-broker` helper, separate
from the execution engines. Main launches it from a fixed verified application path with fixed
arguments and a sanitized environment. Neither model nor renderer can select its executable, argv,
environment, operation name, native flags, or authorization scope.

The exact versioned protocol is a state machine, not generic filesystem RPC:

- `openPickerGrant`, `reopenRememberedGrant`, `revalidateGrant`, `revokeGrant`.
- `listGrant`, `statGrantEntry`, `readGrantChunks`.
- `beginTransaction`, `stageCreate`, `stageReplace`, `stageCopy`, `stageMove`,
  `stageRecoverableRemove`.
- `freezeManifest`, `preflightCommit`, `commitTransaction`, `rollbackTransaction`.
- `beginUndo`, `commitUndo`, `exportPreservedCopies`, `discardStaging`.

Every request binds the main peer, agent, grant, transaction generation, operation quota, and logical
relative path. Only `openPickerGrant` accepts a trusted native-picker result. Renderers and models
send opaque grant IDs plus normalized virtual paths. A crash, protocol/version mismatch, signature
failure, root-identity change, or stale transaction fails closed and never falls back to Node path
operations.

`stageCopy` and `stageMove` are the only two-capability operations: each binds explicit source and
destination grant IDs, relative entries, root identities, access verbs, and expected versions in one
request, then acquires both grants in sorted ID order. A same-root rename uses `stageMove` with
identical grant IDs. Transformed writes still carry the transaction lineage defined in §3 and cannot
masquerade as an ordinary destination-only create. Top-level granted roots cannot be a move source.
Read-only entry grants can provide a read/copy source. `WritableEntryCapability` can replace only its
bound entry; neither entry form provides general destination namespace authority.

- macOS uses a dedicated App-Sandboxed XPC broker service whose only dynamic file extensions are the
  exact task and Buddy Output roots selected through Powerbox/security-scoped pickers; it has no
  ambient home/Documents entitlement.
  Inside that kernel boundary it uses directory descriptors with `openat`/`fstatat`/
  `renameatx_np`, `O_NOFOLLOW`, `AT_SYMLINK_NOFOLLOW`, exclusive creation, and stable device/inode
  checks. Security-scoped bookmarks reactivate only that root. Writable nested-folder grants require
  a packaged proof that the sandbox denies mutation through an already-open descendant after any
  ancestor is reparented outside the granted root at every syscall boundary. Descriptor checks alone
  are explicitly insufficient. If the XPC sandbox/extension does not enforce that denial on the
  pinned macOS build, the profile is not `writeSafe`; because nested folders are part of the product
  promise, filesystem execution does not ship on macOS until a kernel-enforced replacement passes.
- Windows uses handle-relative `NtCreateFile` plus `FileRenameInformationEx`/
  `NtSetInformationFile` with verified `RootDirectory`, `OBJ_DONT_REPARSE`,
  `FILE_OPEN_REPARSE_POINT`, file-ID/volume checks, and explicit rejection of reparse points, ADS,
  device paths, reserved names, and 8.3 aliases. Existing targets are opened with delete/read access
  and sharing that denies competing write/delete handles; if that lease cannot be acquired, the file
  is locked and the transaction does not start. The broker fsyncs a sibling replacement, renames the
  verified target handle to a broker backup, then renames the replacement into the original entry,
  all relative to held directory handles. It does not use path-based `ReplaceFileW` or
  `IFileOperation` as a security primitive. This is a journaled two-rename swap—not an atomic
  exchange—so the NTFS `VolumeProfile` and crash matrix must prove recovery at its missing-entry
  boundary.

The helper has no network code, shell, executable launch, dynamic plugin loading, generic arbitrary
path operation, or path-returning response. Its source, schema, reproducible builds, signing,
notarization, symbols, SBOM, and platform race corpus ship atomically with Buddy.

The macOS service accepts one private app-created XPC endpoint and authenticates the connecting audit
token against Buddy's exact designated signing requirement before activating any sandbox extension.
It permits one main client, binds extensions to that connection, and invalidates them on disconnect,
revoke, or peer mismatch. A same-user impostor process cannot discover or reuse the endpoint.

### 5.2 Grant and path policy

A grant records an opaque ID, access mode, root identity, platform capability, display label, task
owner or remembered status, and timestamps. Absolute path/capability data stays main-only in a
user-only-permission store; it never enters prompts, agent summaries, telemetry, or ordinary renderer
IPC. The sole display exception is a branded `LocalDisplayPath` sent after a fresh local gesture to
the exact main frame of the dedicated network-denied File Access window. It is display-only, cannot
be submitted in any request, is cleared when the window closes, and never reaches another renderer,
provider, log, or persisted UI store; actions return only a main-bound row nonce. The separate
disclosure record binds task, agent, provider/account, grant IDs, allowed data classes, expiry, and
user gesture; it is never persisted as part of a remembered filesystem grant.

An exact-file picker grant is implemented as a read-only, non-enumerable `EntryCapability`: the
broker holds the directly Powerbox/picker-authorized file handle/bookmark and verified file identity;
it does not open or require authority over the parent directory. It cannot list siblings, replace,
create, or rename.

`WritableEntryCapability` additionally holds a separately picker-authorized parent-directory handle
but exposes only replace-exact-entry. The broker may exclusive-create fixed random sibling temporary/
backup names, publish the replacement, rotate the exact identity after commit, and clean/recover those
names; it cannot enumerate or read siblings, choose another basename, create a user-visible sibling,
or rename/move the entry. The provider receives only the exact selected file's name/content. A full
folder grant remains required for any other namespace operation. A folder grant owns namespace
authority only below its root, never over the root's parent entry.

Opening a grant computes a `VolumeProfile` from the actual root volume: stable identity support,
case/normalization behavior, maximum names, exclusive create, same-directory publication with
actual-target backup, quarantine/rename behavior, required file/directory flush semantics, and crash-test
version. Writable access is enabled only for an exact filesystem/profile combination that passed the
packaged corpus. The profile has separate `readSafe` and `writeSafe` gates. A root without
handle-relative containment plus stable root/file identity and pre/post read change tokens is not
grantable at all. If read safety passes but publication/recovery semantics do not, Buddy may offer
read-only access; otherwise it asks for a supported local destination. It never assumes APFS/NTFS
semantics from the path or OS alone.

Model paths are normalized relative POSIX paths below one virtual mount. Reject absolute/drive/UNC/
device paths, `.`/`..`, backslash, NUL/control/bidi, invalid UTF-8, ADS colon, reserved Windows names,
trailing dot/space, 8.3 aliases, overlong/deep paths, Unicode/case-fold collisions, duplicate aliases,
symlinks, hardlinks, junctions/reparse points, sparse files, devices, FIFO, and sockets. Root and every
component are revalidated handle-relatively at read, stage, preflight, commit, and Undo.

Ordinary hidden files remain inside a selected folder's scope, but credential/recovery-bearing paths
are excluded from folder grants: `.ssh`, `.gnupg`, browser profiles, keychains/credential stores,
Buddy data, identity-bound current/historical Buddy recovery/metadata/quarantine subtrees, startup/login items, scheduled-task
definitions, shell profiles, Git hooks, Office template/
macro locations, extension/plugin directories, `.aws`, `.kube`, `.docker/config.json`, `.npmrc`,
`.pypirc`, `.netrc`, cloud/CLI credential directories, `credentials*.json`, token/key stores, and
recognized private-key material. A streaming secret-content detector runs before provider-bound
reads and fails closed on recognized key/token/credential material without echoing bytes, derived
values, or content-bearing errors. Dot-env files are read-excluded by default because their content
may reach the model provider; using one requires selecting that exact file and accepting a specific
disclosure. There is no ancestor fallback or prompt to “allow everything.” ACL/ownership/
executable-bit changes do not ship in V1.

### 5.3 Transaction semantics

Each task owns one copy-on-write transaction:

1. Lazy reads come from the real authorized roots through a no-follow handle. The broker records
   pre-read identity/size/change tokens, streams bounded bytes while hashing, then rechecks identity,
   size, and change token before exposing any bytes. A mismatch discards the read and retries only a
   bounded number of times before `EBUSY`; torn bytes never reach shell, Python, or provider. The
   exact successful read token joins the transaction. Later task reads see that stable base plus its
   staged overlay.
2. Shell/Python mutations become bounded ordered create/replace/move/recoverable-remove operations
   in staging.
3. `finish_filesystem_task` freezes the independently recomputed manifest. Main applies the fixed
   review classification from §3.
4. Before any host mutation, preflight revalidates every root/entry, destination, collision, lock,
   free-space requirement, recovery quota, and current version. Any mismatch conflicts; there is no
   “overwrite newer version anyway.”
5. The broker durably writes and fsyncs a write-ahead journal and all before-images, then performs
   exclusive creates, platform-profiled complete-file replacement/swap, same-volume moves, and
   identity-bound quarantine operations.
6. It verifies final identities/hashes, marks the journal committed, and only then lets the agent say
   done. Failure enters journal-driven roll-back/roll-forward recovery; unresolved external
   interference becomes `indeterminate` under the contract below.

No desktop filesystem provides simultaneous atomic visibility or universal rollback for an
arbitrary multi-file change. Buddy promises complete old-or-new bytes for each individual file,
durable journals/backups, deterministic recovery attempts, and no false success—not globally atomic
visibility or guaranteed multi-file rollback in the presence of unrelated writers. Cross-volume
moves and transactions that cannot preserve displaced bytes are rejected in V1.

External applications also do not participate in Buddy's transaction or locks. Preflight validation
narrows but cannot eliminate the race between the last version check and publication. On a profiled
volume with a tested atomic exchange/replace-with-backup primitive, the broker preserves the actual
displaced target as the backup, verifies its identity/hash, and immediately restores it if it was not
the expected version. On the documented NTFS profile, the broker first acquires the target lease
that excludes competing write/delete handles, then performs the journaled target-to-backup and
replacement-to-target renames from §5.1; inability to acquire or retain that lease is a lock/conflict,
not permission to continue. The NTFS operation is not an atomic exchange and its crash recovery must
handle the journaled missing-entry boundary. Another process may briefly observe an individual
publication on either platform. If recovery or a new external race prevents restoration, the journal
becomes `indeterminate`, keeps every recovered byte, names the affected relative paths locally, and
never reports success.

On APFS, an uncooperative process that already holds a writable descriptor can keep modifying the
displaced inode after an atomic exchange; advisory locks cannot prevent it. Buddy's durable immutable
before-image preserves the last version it successfully observed, while the actual displaced inode
is retained separately and monitored through the recovery window. The guarantee is explicitly
limited to Buddy-observed versions, not unknowable concurrent writes. Any observed post-exchange
write, inability to establish the required quiescence, or mismatch among the immutable before-image,
displaced inode, and expected token produces `indeterminate`; Buddy retains every observed version
and does not claim complete recovery.

Creation never overwrites: collisions suffix deterministically. Replacements preserve appropriate
user metadata only after validation. `rm` and delete tools first atomically rename the verified
handle into a broker-owned, user-inaccessible, same-volume quarantine after its recovery copy and
journal are durable. Generic path-based macOS/Windows Trash APIs are never the security boundary.
After commit, Buddy may move the quarantined object to OS Trash from that controlled location; if it
cannot verify the transfer or platform policy would permanently delete it, the object stays in
quarantine through the Undo window. Hard delete does not exist in agent tools. A task cannot evade
review/quotas by splitting work across shell calls.

Undo journals are user-only local data retained for 30 days, with space reserved before commit and
no earlier silent eviction. Undo reverses the whole transaction and revalidates current hashes. If a
file changed after Buddy's commit, Undo restores the prior bytes as a noncolliding recovered copy and
does not overwrite newer work. The user may explicitly clear recovery data early.

### 5.4 Persistence and audit

Main persists remembered grants, transaction-bound recovery capabilities, active transaction
WAL/staging, recovery before-images, and a renderer-safe recent-work index in separate stores.
Noncommitting active transactions are discarded on restart; committing transactions recover before
filesystem agents start. If recovery becomes `indeterminate`, Buddy still opens its normal voice/UI
surfaces, preserves all recovered bytes, and blocks mutations under the exact affected root identity
plus any overlapping ancestor or descendant grant. Unrelated roots remain usable. The block follows
root identity rather than a stored path and survives restart; Recent Work presents the exact affected
relative paths and recovery actions locally. Persistent grants are reopened and identity-checked
before use, never trusted by stored path alone.

The app-wide quota covers staging, WAL, before-images, validators, queued jobs, and temporary bytes;
minimum free space is reserved. If 30-day recovery cannot be guaranteed, the mutation is refused
before commit. Audit/session events contain operation class, opaque root label, relative-path hash,
sizes, timing, and before/after content hashes—not absolute paths, filenames by default, contents,
scripts, stdout, directory listings, or capability material.

## 6. Content validation

Moving, copying, or trashing an existing bounded regular file may treat its bytes as opaque; this
does not authorize execution or Preview. Creating or changing file content ships only for a tested
profile. V1 content profiles remain UTF-8 text/Markdown/JSON/CSV/allowlisted source and re-encoded
PNG/JPEG. PDF, OOXML, archives, HTML/SVG, executables, installers, shortcuts, macros, disk images,
unknown types, and polyglots cannot be generated or content-edited until their complete isolated
canonicalizer ships. Existing files of those types may be relocated or trashed without parsing under
the normal review rules.

Complex parsing never runs in main, the results renderer, panel/audio renderer, or preview renderer.
Each disposable validator is node-less, host-filesystem-less, OS-sandboxed, network-denied,
resource-capped, and receives only bounded staged bytes. Parser-RCE canaries are mandatory.

A validator's type/safety claim and output are hostile even when hashes match. Each shipped parser
emits a bounded typed IR to an independent minimal serializer, or a separate implementation verifies
the canonical bytes against the complete grammar. A format without both containment and independent
canonical-output assurance does not ship.

Text previews are escaped; images are decoded/re-encoded; CSV is parsed/reserialized and
formula-looking cells are neutralized. Preview uses a separate opaque-origin, no-preload, no-storage,
network-denied sandbox. **Open** is offered only for a committed path whose canonical profile permits
OS launch and only after an explicit user gesture; it never opens staging bytes or arbitrary active
content.

## 7. Repository integration

- As part of the same big-bang implementation, update `docs/ARCHITECTURE.md` and
  `docs/AGENT-MODE.md` so their original read-only/file-write deferrals point to this contract.
  `docs/AGENT-COMPUTER-USE.md` keeps only the separation rule; no browser grants or action-gate
  implementation is reused here.
- Add `src/main/filesystem/` for grants, path policy, broker client, transactions, WAL/recovery, Undo,
  and recent-work persistence. Only this subsystem touches user files.
- Add `src/main/execution/` for the disposable shell/Python hosts, runtime policy, validators, and
  bounded protocol. It receives virtual paths/bytes and proposed diffs, never native grants.
- Add the source-built signed `buddy-file-broker` helper and generated typed main-side client;
  renderer code never imports it. Do not put any filesystem implementation in `src/main/computer/`.
- `AgentBrief` gains a discriminated `capabilityMode: 'research' | 'browser' | 'filesystem'`.
  Filesystem mode carries `executionEnabled` plus opaque grant/disclosure summaries. Runner
  construction fails fast if more than one mode's instructions, budgets, registries, ports, or
  context are present. Filesystem prompting replaces—not appends to—the current read-only/web-search
  instructions and starts with no research/browser history.
- Tool registration, instructions, budgets, and context are selected by that mode. A filesystem
  runner receives only `shell_exec`, `python_exec`, and `finish_filesystem_task`; it receives no
  hosted search/fetch/screen/browser/computer tools.
- `AgentManager` owns the filesystem session and transaction. `AgentRunner` receives narrow
  filesystem/execution ports, serializes every mutation deterministically, waits for a grant/review
  when needed, and disposes in `finally`. Current same-round parallel tool execution must not apply
  to filesystem tools.
- Add a generic manager-owned `park/resume` state that pauses model/turn budgets and holds no active
  model request while a grant or review waits. Review resolution resumes exactly one frozen
  transaction generation. Cancellation aborts execution/staging, but once broker commit begins it
  crosses a non-abortable recovery barrier owned by `FilesystemManager`; the runner cannot finalize
  until the barrier resolves to committed/rolled-back/indeterminate.
- Shutdown transfers every committing transaction to broker recovery ownership instead of relying on
  the current five-second runner join. Graceful quit waits for a safe journal boundary; forced OS
  termination is recovered before new filesystem work on next launch. Generic runner disposal cannot
  delete a live WAL or before-image.
- Filesystem completion has explicit phases: `needs_grant`, `working`, `review_changes`, `committing`,
  `committed`, `conflict`, `rolling_back`, `recovering`, `indeterminate`,
  `awaiting_local_answer`, `local_answer_ready`, and `read_complete`. Only `committed` becomes a
  mutation `done` and triggers the normal voice continuation. An empty recomputed manifest may enter
  `awaiting_local_answer`; successful one-shot delivery enters `local_answer_ready` and then terminal
  `read_complete`, which opens the local Results affordance without voice continuation or Undo/
  recovery state.
- `src/shared/types/agents.ts` gains renderer-safe grant summaries, capped change previews,
  recent-work/Undo metadata, filesystem phase, and friendly file/execute step kinds.
  `src/shared/ipc.ts` gains typed choose-grant, review, cancel, show-result, Undo, grant-list/revoke,
  and private execution MessagePort contracts. Shared changes require coordinated ownership.
- Do not reuse browser `panel:approval` or its action gate. Filesystem review is bound to an immutable
  transaction manifest and lives in the focusable results/review window. Invoke handlers validate
  exact sender, agent, transaction, generation, state, and nonce; renderers never submit paths.
- Raw scripts, contents, stdout/stderr, absolute paths, before-images, capabilities, and directory
  listings never enter `AgentSummary.output`, `agents.json`, session recordings, logs, crash metadata,
  or renderer broadcasts.

## 8. Failure contract

Internally recoverable nonzero exits remain between the buddy and tool. Terminal UI never shows a
command, exit code, invalid path, or raw quota. Examples:

| Failure                     | User copy/action                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Missing/revoked grant       | “I don't have access to Project anymore. Choose it again.”                                               |
| Unsupported content edit    | “I can't safely edit that file type yet. I can move it, or work with text, CSV, JSON, PNG, or JPEG.”     |
| File/task limit             | “That change is too large for me to make safely. Try a smaller folder or ask for fewer changes.”         |
| External edit conflict      | “Budget.csv changed while I was working, so I didn't overwrite it.” Offer Retry with newest / Keep both. |
| Locked file                 | “Close Budget.csv and try again, or I can keep my version as a copy.”                                    |
| Disk/recovery space         | “I need more free space to change these files safely. Nothing was changed.”                              |
| Runtime crash before commit | “I couldn't finish the changes. Your files weren't changed—try again.”                                   |
| Commit recovery             | “I stopped safely and restored the earlier files.” Never say cancelled before recovery completes.        |
| Indeterminate recovery      | “I couldn't safely finish restoring two files. I kept both versions—review them before continuing.”      |
| Undo conflict               | “That file changed afterward, so I restored the earlier version as a separate recovered copy.”           |
| Failed runtime self-test    | “File tools are unavailable right now. Restart Buddy; if that doesn't fix it, reinstall Buddy.”          |

Before commit, partial work remains staged. During a multi-file commit, other processes may observe
individual complete-file operations or the documented NTFS swap boundary; Buddy never calls that
partial state done. It completes recovery or
records a durable truthful `indeterminate` result with every preserved version. There is no **Save
draft** path that bypasses the frozen manifest, validation, recovery, or review policy. Runtime
crash/timeout/OOM never auto-retries untrusted code. No failure expands a grant, enables network,
direct-mounts a host path, permanently deletes, or falls back to native execution.

## 9. Security invariants

1. No user/model data is interpreted as a native executable path, argv, environment, stdin command,
   script, or OS-shell invocation. Shell syntax is interpreted only by the fixed virtual engine.
2. Only the signed filesystem broker touches host files. Execution/validator/preview renderers never
   receive native paths, handles, bookmarks, Node `fs`, or direct mounts.
3. Every operation is relative to an explicit file/folder grant and revalidates root/target identity
   without following symlinks, junctions, reparse points, hardlinks, or aliases.
4. Main treats every execution renderer, output, filename, staged operation, and artifact as hostile.
5. Host mutations are staged, bounded, version-checked, journaled, recoverable, and classified by
   mechanical review rules before commit. Permanent delete and irreversible fallback do not exist.
6. Creation never overwrites. Version checks plus replace-with-backup prevent silent loss of newer
   external work; an unresolvable external race becomes a truthful `indeterminate` recovery result,
   never false success.
7. Recovery space is reserved before mutation; Undo remains available for 30 days and is itself
   conflict checked.
8. Network/runtime package loading are absent and not user-grantable. A host-filesystem run never
   composes with web, browser, screen, or computer-use tools.
9. Limits apply before reads/allocations/writes; cancel destroys execution hosts and cannot report
   completion until transaction rollback/recovery reaches a safe boundary.
10. Grant, transaction, review, result, and Undo authorization are task/sender/generation/manifest/
    nonce bound and revoked on end. Failure cannot broaden scope or bypass validation/recovery.

## 10. Mandatory spike and release gates

Implementation approval requires packaged macOS and Windows proof, not dev-server demos:

- **Shell fidelity:** exact corpus for quoting, variables, globs, substitutions, heredocs, pipes,
  redirects, conditionals, loops, functions, exit codes, `grep`/`sed`/`awk`/`jq`/`find` and every
  promised command; intentional GNU Bash gaps documented.
- **Python packages:** cold offline create/read/write fixtures for every pinned wheel and promised
  output. Tampered runtime/wheel/manifest refuses to load.
- **Grant isolation:** canaries outside selected roots, in parent/siblings, temp, userData, settings,
  environment, browser profiles, another task, clipboard, and credentials remain unreadable and
  unmodifiable; selected ordinary files really can be read/changed; native process attempts fail.
- **Network:** guest and compromised-renderer attempts across HTTP/DNS/TCP/UDP/WebSocket/WebRTC/
  ICE/STUN/WebTransport/QUIC/beacon/prefetch/loopback/LAN/custom protocols produce zero packets in
  OS-level capture. Policy probes separately prove the session is offline, every URL request is
  cancelled, `connect-src 'none'` applies to documents/workers, and `webrtc 'block'` prevents local
  candidates, STUN checks, and remote-candidate connectivity.
- **Limits/recovery:** parser bombs, infinite loops, recursion, allocation/output/file/node floods,
  broad-tree scans, blocked reads, concurrent tasks, crash, cancel, sleep/quit. Each terminates within
  SLA, returns resources/capacity, preserves or recovers host truth, and the next normal job succeeds.
- **Bounded protocol:** wrong sender/nonce/generation, duplicate/late/out-of-order/oversized chunks,
  backpressure, invalid UTF-8/control/ANSI/bidi output, and pre-allocation quota boundaries.
- **Disclosure boundary:** remembered grants never imply provider disclosure; wrong/stale provider,
  account, task, or scope prevents model traffic. Capture traffic for filenames, secret-print,
  base64, error, manifest, and stdout attacks; only the task-approved roots/data classes may leave.
  A tainted filesystem completion followed by voice/browser/computer/connector/send tasks carries no
  model summary, filename, root label, diff, stdout, derived value, or prior message into those runs.
- **Native broker/grants:** picker and remembered grants, revoke mid-read/commit, root replacement,
  traversal, drive/UNC/device/ADS/reserved/8.3/case/Unicode paths, symlink/junction/reparse/hardlink
  races, every already-open ancestor reparented outside the granted macOS root at every syscall
  boundary, disk full, permission loss, removable/cloud volumes, and stale identity. Probe and bind
  the exact `VolumeProfile`; profiles proven `readSafe` but not `writeSafe` remain read-only, while
  read-unsafe, unknown, or spoofed profiles are rejected. Run against the packaged broker, not a Node
  mock; assert zero access outside grants and fail-closed protocol, signature, capability, and version
  mismatch. Same-user impostor XPC clients, wrong audit tokens/designated requirements, second clients,
  endpoint replay, and post-disconnect extension reuse all fail before any file operation.
  Ordinary-grant overlap tests cover current/historical reserved recovery subtrees, ancestors,
  descendants, rename races, and remembered reactivation; protected bytes are never enumerable,
  mutable, or provider-visible, while ordinary output deliverables remain explicitly re-grantable.
- **Transactions:** property tests for overlay visibility, deterministic ordering, accumulated review
  counts, collisions, external edits, locked files, adjacent-temp replacement, same/cross-volume
  moves, Trash, APFS writers held open before/during/after exchange, and every injected
  WAL/fsync/commit/rollback crash point. Assert every Buddy-observed version is preserved, exact final
  hashes when quiescence is proven, truthful `indeterminate` otherwise, no false success, and startup
  recovery before new work.
- **Review policy:** zero extra prompt for permitted ordinary creates/selected-file edits; exact one
  immutable-manifest review for Trash, bulk, unselected replacement, and second-root entry; top-level
  root rename is refused with zero host mutation. Chunking/reordering/retry cannot evade counts;
  changed bytes invalidate approval.
- **Undo:** reserve-space boundary, 30-day retention, created/replaced/moved/trashed reversal, later
  external edit, duplicate Undo, partial recovery, explicit early clear, and quota refusal before
  mutation.
- **Indeterminate export:** forged/replayed/wrong-transaction recovery capabilities, altered preserved
  sets, destination races, exclusive non-overwriting names, partial writes, hash mismatch, duplicate
  activation, and crash recovery. Export binds the exact transaction/set, verifies every output hash,
  and leaves the root blocked and **Mark resolved** disabled on every failure.
- **Artifacts:** type spoof/polyglot, image bombs, CSV formulas and, when enabled, full PDF/OOXML
  parser/canonicalizer corpora. Preview escape and forged action IPC fail.
- **Persistence/UX:** choose grant → work → routine commit or exact review → committed result → Show/
  Review/Undo → restart/recovery → revoke; keyboard/button review, voice open/status-only behavior,
  and proof that Realtime/model voice can never resolve a review nonce; persistent recent work,
  remembered scope, unsupported-volume rejection, conflicts, full-quota refusal, and nontechnical
  acceptance testing.
- **Local answers:** empty-manifest finish → task/generation-bound one-shot acceptance → hostile-text
  local delivery → close/reopen → explicit delete/app quit. Packet capture, forged frame/nonce, late
  response, navigation/reload/storage/IPC attempts, and a subsequent screen-capable mode prove the
  answer never reaches Realtime, `AgentSummary`, logs, persistence, another renderer, or another
  capability mode; restart exposes no stale row or unresolved flag.
- **Packaging/SBOM:** all runtime assets exist offline in ASAR/installers, hashes bind to signed app
  source, and Apache-2.0 (`just-bash`), MPL-2.0/PSF (Pyodide), and every wheel/transitive license are
  included and reviewed.
- **Electron hardening:** packaged inspection proves application sandboxing is enabled, no
  `--no-sandbox`, RunAsNode/NODE_OPTIONS/CLI-inspector fuses are disabled, ASAR integrity and
  only-load-from-ASAR are enforced, and execution runs in its own renderer PID.

Critical blockers before ship:

1. Packaged handle-relative/no-follow grant enforcement and root-identity proof on macOS and Windows.
2. Crash-injected WAL/rollback/Undo proof for every supported host mutation, including quarantine and
   any optional verified OS Trash transfer.
3. Enforceable renderer/WASM total-memory ceilings and proof destruction kills all workers within
   the cancellation SLA.
4. Bounded broker/overlay APIs that never materialize an over-quota tree or file first.
5. Exact canonicalizers for every promised content-edit format.
6. Pinned Chromium proof that the enforced `webrtc 'block'` policy covers execution documents and
   workers; otherwise select an OS-enforced per-host network sandbox before ship.

If a blocker fails, the feature does not fall back to native shell or broaden permissions. The
runtime/format promise is reduced honestly or the architecture is revisited.

## 11. Full-rollout workstreams and estimate

All workstreams ship together; no intermediate unsafe mode is supported.

- Runtime/package spikes, capability filesystem, shell parity, sandboxed hosts: **3–4 days**.
- Native grant broker, path/race hardening, persistent grants: **4–5 days**.
- Staging, WAL, conflict checks, commit/rollback/Trash/30-day Undo: **4–5 days**.
- Agent capability routing, sequential tools, lifecycle/review/activity: **3–4 days**.
- Picker/grant/review/recent-work/Review/Show/Undo UX: **3–4 days**.
- Canonicalizers: **separate estimate after exact V1 formats/libraries are selected**.
- Cross-platform adversarial, crash-injection, packaging, accessibility, and UX corpus: **4–5 days**.

Base real-filesystem system before complex PDF/OOXML canonicalizers: **21–27 engineering days**. Do
not reuse the earlier 6–7 or 14–19 day estimates; they assumed copy-only import/export and omitted
host grants, live conflicts, transactional commit/recovery, Trash, and guaranteed Undo.

## 12. Primary references

- [`just-bash` README](https://github.com/vercel-labs/just-bash/blob/main/README.md)
- [`just-bash` threat model](https://github.com/vercel-labs/just-bash/blob/main/THREAT_MODEL.md)
- [`just-bash` filesystem interface](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/src/fs/interface.ts)
- [Pyodide package loading](https://pyodide.org/en/stable/usage/loading-packages.html)
- [Pyodide workers](https://pyodide.org/en/stable/usage/webworker.html)
- [Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [WASI capabilities](https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md)
- [WebContainers commercial usage](https://webcontainers.io/enterprise)
