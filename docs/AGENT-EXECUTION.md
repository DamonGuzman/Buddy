# Buddy filesystem and shell execution

## Decision

Every background helper gets immediate real `/bin/zsh` access to a user-selected folder without
copying or hashing the complete tree. The selected folder is mounted into the helper's Seatbelt
policy as **read-only**. When the helper needs to edit, it names exact relative paths through
`stage_paths`; Buddy materializes only those files or small directories in a private, sparse
staging area. The helper edits that area with `run_staged_shell`, and the user reviews the resulting
path-scoped diff before Apply.

The foreground Buddy remains a voice/text orchestration interface. It can delegate through
`spawn_agent`, but it never receives filesystem or shell tools. Browser/computer use remains a
separate actor and never shares a model context with local file contents.

## User flow

1. The user chooses **Work in a folder**, or their first helper request opens the native picker.
2. The picker grants an opaque, owner-only capability retained until the user changes or removes it.
3. Helper admission creates only a tiny task record, empty staging directory, synthetic home/tmp,
   and Seatbelt profile. It never scans the project, `.git`, `node_modules`, or build products.
4. `run_shell` inspects the selected folder directly. Seatbelt denies every write to it.
5. Before an edit, the helper calls `stage_paths` with exact files or small directories. Staging `.`
   or the whole project is rejected, as are excessive path/entry/byte counts.
6. `run_staged_shell` changes the sparse private area. New paths can be named before they exist.
7. Buddy shows created, modified, and deleted paths. **Apply** conflict-checks only the staged path
   roots, captures their durable before-image, publishes, and verifies hashes. **Discard** deletes
   the sparse task without touching the selected folder.
8. **Undo** proceeds only if Buddy's published paths still match. It restores the path-scoped
   before-image and never overwrites newer edits.

## Why there is no eager project copy

APFS clone files avoid copying file bytes, but cloning a directory still traverses every directory
entry. Hashing a full baseline is even more expensive. Large dependency trees therefore made a
safe but read-only inspection feel hung. Lazy staging removes that work from startup entirely and
makes the cost proportional to the paths the helper actually changes.

macOS has no built-in unprivileged overlay filesystem. Buddy therefore exposes the lower read-only
tree and upper sparse staging area as two explicit shell tools instead of pretending they are one
merged writable directory. This is mechanically enforceable and does not require FUSE, root, a
kernel extension, or command-text heuristics.

## Containment

Every shell command runs through `/usr/bin/sandbox-exec` with a generated deny-by-default Seatbelt
policy. The policy permits:

- reads and executable mapping from the selected folder plus required macOS/Xcode/Homebrew paths;
- writes only in the sparse staging area, synthetic task home, and task temporary directory;
- no network operations or inherited network credentials;
- no reads of unrelated user folders.

Buddy constructs the environment from an allowlist. It never inherits API keys, SSH agent sockets,
cloud tokens, proxy settings, or shell startup files. Zsh runs as `/bin/zsh -dfc`.

On first use the runner performs a fail-closed containment self-test. If a write can escape its
private paths, shell execution remains disabled. `rm -rf /` cannot change the selected folder or
other host paths; the source shell is read-only and the staged shell can destroy only the sparse,
disposable upper area.

## Transactions and recovery

Task records, sparse baseline/staged manifests, and before-images live under
`<userData>/filesystem/tasks/<task-id>/` with owner-only permissions. JSON records are atomically
replaced. Only staged files are SHA-256 hashed. Existing ancestor directories are recorded without
recursively scanning unrelated siblings.

Before publication Buddy verifies that all staged path roots still match their baselines. It then
copies only their before-images, persists `publishing`, applies the sparse manifest, and verifies the
published hashes. Undo similarly persists `undoing` before restoration. Startup recovers an
interrupted mutation from the path-scoped before-image.

Terminal operations clear the task record, recovery pointer, and renderer state together. Cancel is
idempotent: a stale task ID means the task is already gone, not a user-visible error.

## Ownership and deletion boundary

- `src/main/filesystem/` owns grants, sparse staging, Seatbelt, manifests, publication, and Undo.
- `src/main/agents/tools/filesystem.ts` is the only model-tool adapter.
- `src/shared/types/filesystem.ts` and `filesystem:*` IPC are the renderer contract.
- the whisper filesystem card is the only user-facing surface.

Removing those pieces and their composition-root wiring returns Buddy to read-only/browser agent
behavior without altering the browser security subsystem.

## Current platform boundary

This implementation fails closed outside macOS. Simulator control remains a separate typed native
capability: shell commands do not receive Apple Events or broad CoreSimulator services. Local
builds are possible when their required project files are staged and their caches/outputs stay in
the private task paths; simulator boot/install/launch belongs to the simulator controller.
