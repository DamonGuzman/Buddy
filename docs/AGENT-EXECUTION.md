# Buddy filesystem and shell execution

## Decision

Buddy's macOS filesystem agent uses real `/bin/zsh` and native macOS programs against an on-disk,
task-scoped clone of a user-selected folder. The selected folder is read to create the clone but is
never writable by the agent process. When the agent finishes, Buddy computes a change set and waits
for the user to choose **Apply changes**. Publication is conflict-checked and retains a durable
before-image for **Undo**.

This capability is deliberately separate from browser/computer use. A filesystem agent receives no
web search, web fetch, browser, screenshot, mouse, or keyboard tools. A browser agent receives no
filesystem or shell tools.

## User flow

1. The user opens the whisper and chooses **Work in a folder**.
2. A native folder picker grants one opaque, process-local capability. Renderer-supplied paths do not
   authorize access.
3. Buddy creates an APFS copy-on-write clone in its private task storage. If cloning is unavailable,
   it verifies free space before making a full metadata-preserving copy.
4. The filesystem helper works in that private copy with real zsh. The whisper continuously says that
   the original is unchanged.
5. Buddy shows created, modified, and deleted paths. The user chooses **Apply changes** or **Discard**.
6. Apply first verifies that the selected folder still exactly matches the baseline. If another app or
   person changed it, publication stops rather than overwrite newer work.
7. Buddy clones a durable before-image, applies the reviewed manifest, verifies every result hash, and
   then offers **Undo** or **Keep changes**.
8. Undo only proceeds if the folder still matches Buddy's published manifest. It never overwrites
   edits made after publication.

## Containment

Every shell command is launched through `/usr/bin/sandbox-exec` with a generated deny-by-default
Seatbelt policy. The policy permits:

- process creation inherited by the complete descendant tree;
- reads of the staged workspace and required macOS/Xcode/Homebrew runtime paths;
- writes only in the staged workspace, synthetic task home, and task temporary directory;
- no network operations or network credentials;
- no reads of unrelated user folders.

The environment is constructed from an allowlist. It never inherits Buddy credentials, API keys,
SSH agent sockets, cloud tokens, proxy configuration, or the user's shell startup files. Zsh runs as
`/bin/zsh -dfc`, so `.zshrc`, `.zprofile`, aliases, and plugins are not loaded.

On first use, the runner performs a fail-closed self-test: it must create and read a file inside its
workspace while a write beside the workspace is denied. If the test fails, no agent shell launches.
There is no unsandboxed fallback.

`rm -rf /` therefore cannot mutate the host filesystem. At worst it can destroy paths beneath the
disposable workspace when it reaches them. The selected folder remains untouched unless publication
later receives explicit user confirmation.

## Transactions and recovery

Task records, baseline/staged manifests, and before-images live under
`<userData>/filesystem/tasks/<task-id>/` with owner-only permissions. JSON records are replaced
atomically. Publication and Undo persist their transitional state before mutating the selected
folder. On startup, an interrupted mutation is reconciled from the before-image before the feature
becomes usable again.

The manifest supports directories, regular files, and symbolic links. Special filesystem objects
fail fast. Every regular file is SHA-256 hashed. Symlink escapes are contained by Seatbelt while the
agent runs; publication only recreates the symlink object and never follows its target.

## Ownership and deletion boundary

The implementation is intentionally removable:

- `src/main/filesystem/` owns grants, workspaces, Seatbelt, manifests, publication, and Undo.
- `src/main/agents/tools/filesystem.ts` is the only model-tool adapter.
- `src/shared/types/filesystem.ts` and the `filesystem:*` IPC channels are the renderer contract.
- the whisper's filesystem card is the only user-facing surface.

Removing those pieces and their small composition-root wiring returns Buddy to its previous
read-only/browser agent behavior without altering the browser security subsystem.

## Current platform boundary

This implementation fails closed outside macOS. Simulator control remains a separate typed native
capability: sandboxed shell commands do not receive LaunchServices, Apple Events, or broad
CoreSimulator services. Xcode builds that stay within the staged workspace are supported by the
filesystem runner; boot/install/launch operations belong to the future simulator controller.
