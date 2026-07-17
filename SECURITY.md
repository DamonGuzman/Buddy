# Security Policy

Buddy captures screenshots, records microphone audio, stores an encrypted
OpenAI API key, and (with explicit opt-in) drives a browser and desktop input.
We take vulnerabilities in any of those surfaces seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via
[GitHub private vulnerability reporting](https://github.com/DamonGuzman/Buddy/security/advisories/new).
Include reproduction steps, the affected platform (macOS/Windows), and the
version or commit.

We will acknowledge reports as quickly as we can and keep you informed of the
fix and disclosure timeline.

## Scope notes

- Buddy's persistent browser profile is hardened but is **not** advertised as
  a security sandbox (see the README's known limitations). Reports that
  bypass the ActionGate, the independent action reviewer, approval flows,
  credential/secret redaction, or the SSRF/private-network guards are very
  much in scope.
- The API key must never leave the main process or appear in logs,
  transcripts, or debug output — any leak path is in scope.
- Screen capture happening without an explicit user action is in scope.
