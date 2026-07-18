# Buddy filesystem and shell execution

## Decision

Every background helper gets immediate real `/bin/zsh` access to a user-selected folder without
copying or hashing the complete tree. Commands run directly on the host with the Buddy user's
filesystem and network permissions; there is no Seatbelt or other OS sandbox. When the helper needs
to edit transactionally, it names exact relative paths through
`stage_paths`; Buddy materializes only those files or small directories in a private, sparse
staging area. The helper edits that area with `run_staged_shell`, validates the result, and names the
primary finished artifact with `present_file`. Completion is the transaction boundary: Buddy
conflict-checks and publishes the path-scoped changes, immediately opens that artifact, and hands
the result back to the foreground conversation. No separate approval step sits between helper
completion and Buddy's handoff.

The foreground Buddy remains a voice/text orchestration interface. It can delegate through
`spawn_helper_buddy`, but it never receives filesystem or shell tools itself. Every background
helper receives these filesystem tools and Buddy's persistent browser tools in the same model
context; browser actions remain mechanically governed by ActionGate.

Every filesystem tool receives the same required `description` argument as the other
helper tools: 3–12 simple, non-technical words describing the current action. Buddy validates it
before running the tool and shows it directly in the helper's activity card.

Every helper also receives the complete Firecrawl tool set: search, scrape, map,
crawl lifecycle, batch scrape lifecycle, and research. The shell tools remain instructed not to
make network requests; current web material must go through the typed, abort-aware Firecrawl
transport instead. This keeps Firecrawl universal without letting arbitrary shell commands inherit
the encrypted key or bypass the web-response safety envelope.

Every helper also receives the durable memory tools and a metadata-only catalog naming the
owner-only `<userData>/memories` directory. Helpers may inspect those Markdown files by
absolute path with read-only `rg` or `cat` commands even though other unrelated paths remain out of
scope. They must use `memory_save` and `memory_delete` for mutations; direct shell writes would
bypass the validated, atomic memory-store contract.

## User flow

1. The user chooses **Work in a folder**, or their first helper request opens the native picker.
2. The picker grants an opaque, owner-only capability retained until the user changes or removes it.
3. Helper admission creates only a tiny task record, empty staging directory, and synthetic
   home/tmp. It never scans the project, `.git`, `node_modules`, or build products.
4. `run_shell` starts in the selected folder and is intended for inspection. Because it is an
   ordinary host process, read-only behavior is a model instruction rather than an OS guarantee.
5. Before an edit, the helper calls `stage_paths` with exact files or small directories. Staging `.`
   or the whole project is rejected, as are excessive path/entry/byte counts.
6. `run_staged_shell` changes the sparse private area. New paths can be named before they exist.
7. The helper validates its work, calls `workspace_changes`, and selects one non-executable regular
   output file with `present_file`. Executable and OS-launcher artifact types are rejected. If the
   helper omits that tool, Buddy opens the only safely presentable changed file or reveals the
   selected folder when the output is genuinely multi-file.
8. Helper completion automatically conflict-checks only the staged roots, captures their durable
   before-image, publishes, and verifies hashes. Markdown opens as rich content in Buddy's native
   document window; other selected outputs use their OS default app. Buddy receives the result
   continuation whether publication or presentation succeeds or fails.
9. **Undo** proceeds only if Buddy's published paths still match. It restores the path-scoped
   before-image and never overwrites newer edits.

## Parallel helpers

Each helper owns an independent task record, sparse workspace, baseline, before-image,
and Undo history. There is no global "current filesystem task" and no client-side helper count
limit. A running, failed, published, or undoable task never blocks preparation of another helper.

Helpers execute concurrently. Staging snapshots and the brief final publication/Undo critical
sections are queued per selected root so two helpers cannot race a baseline or write boundary.
Disjoint staged paths publish one after another without user involvement; overlapping paths make
the later publication fail its baseline check instead of overwriting newer work. This queue is an
integrity lock, not an admission limit, and no manual Apply/Approve state exists.

## Why there is no eager project copy

APFS clone files avoid copying file bytes, but cloning a directory still traverses every directory
entry. Hashing a full baseline is even more expensive. Large dependency trees therefore made a
safe but read-only inspection feel hung. Lazy staging removes that work from startup entirely and
makes the cost proportional to the paths the helper actually changes.

macOS has no built-in unprivileged overlay filesystem. Buddy therefore exposes the selected tree
and upper sparse staging area as two explicit shell tools instead of pretending they are one merged
writable directory. The staging workflow remains the mechanism for verified publication and Undo,
but without an OS sandbox a helper command can bypass it and modify any path available to the user.

## Host execution boundary

Every shell command is spawned directly as `/bin/zsh -dfc` with the same operating-system identity
as Buddy. It can read and write any path the signed-in macOS user can access, execute installed
applications and command-line tools, and make network connections. The selected-folder picker,
working-directory validation, staging limits, and transaction checks do not constitute containment.

Buddy still constructs the environment from an allowlist and uses a synthetic task `HOME` and
`TMPDIR`. It does not inherit API keys, SSH agent sockets, cloud tokens, proxy settings, or shell
startup files. Those environment controls reduce ambient inputs but are explicitly not a security
boundary: commands can read credential files and other user data directly from known filesystem
paths. Destructive commands can affect the selected folder or any other writable host path.

The runner preserves POSIX termination semantics in every tool result. A signal-killed shell
returns `128 + signal` (for example, `137` for `SIGKILL`) together with `terminationSignal` and an
actionable diagnostic; it is never collapsed into an ambiguous exit `128`. Helpers must treat that
result as a hard failure and may not retry the same launch through a slightly different wrapper.
On macOS, executables inside another app's private `Contents/Frameworks` or `Contents/Resources`
directories can carry signed-parent launch constraints. Helpers use the app's documented CLI or
signed `Contents/MacOS` entrypoint instead. This is an external code-identity requirement, not a
Buddy sandbox restriction.

## Transactions and recovery

Task records, sparse baseline/staged manifests, and before-images live under
`<userData>/filesystem/tasks/<task-id>/` with owner-only permissions. JSON records are atomically
replaced. Only staged files are SHA-256 hashed. Existing ancestor directories are recorded without
recursively scanning unrelated siblings.

On helper completion Buddy verifies that all staged path roots still match their baselines. It then
copies only their before-images, persists `publishing`, applies the sparse manifest, and verifies the
published hashes before opening anything. A conflict or malformed presentation target fails the
handoff without applying changes. Undo similarly persists `undoing` before restoration. Startup
recovers an interrupted publication from the path-scoped before-image and marks the task failed;
there is no latent approval state to resume.

Startup discovers every independent task record directly. Terminal operations clear only the
addressed task and renderer state; other helpers and Undo histories remain intact. Cancel is
idempotent: a stale task ID means the task is already gone, not a user-visible error.

## Ownership and deletion boundary

- `src/main/filesystem/` owns grants, sparse staging, host shell execution, manifests, publication,
  and Undo.
- `src/main/agents/tools/filesystem.ts` is the only model-tool adapter.
- `src/main/agents/tools/firecrawl.ts` and browser tools are registered alongside those filesystem
  tools for every helper; the Firecrawl key never enters the shell environment.
- `src/shared/types/filesystem.ts` and `filesystem:*` IPC are the renderer contract.
- the whisper filesystem card reports progress and retains **Undo** / **Keep** after the automatic
  handoff; it is no longer an approval surface.

Filesystem and browser composition are both required helper-runtime dependencies; removing either
makes helper admission fail closed.

## Current platform boundary

This implementation fails closed outside macOS. Host shell commands are not restricted from Apple
Events, CoreSimulator services, or other user-accessible facilities. Simulator control remains a
separate typed native capability in Buddy's model tool surface, but the shell itself is no longer a
security boundary. Local builds remain compatible with the sparse staging workflow.
