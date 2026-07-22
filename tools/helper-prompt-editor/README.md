# Helper Buddy prompt editor

Run `npm run prompt:edit` from the repository root. The command starts a loopback-only development
server and opens the helper-buddy system prompt in a rich-text editor. Use the toolbar or normal
keyboard shortcuts; you never need to type Markdown syntax. Press **Save prompt** or Command/Ctrl+S
to atomically update `src/main/agents/helper-buddy-prompt.md`.

This is a developer tool only. It is not bundled into Buddy and does not add an end-user setting.
Each process uses an unguessable session token, and stale editors cannot overwrite a prompt that
changed on disk.
