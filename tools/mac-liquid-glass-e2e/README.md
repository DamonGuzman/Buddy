# macOS Liquid Glass E2E

This harness runs the production `buddy-macos-native.node` bridge inside the repository's real
Electron runtime. It requires macOS 26 or newer and an installed macOS 26 SDK. Other hosts report
an explicit skip; they never substitute CSS or Electron vibrancy for AppKit Liquid Glass.

```sh
npm run test:liquid-glass:mac
```

The runner rebuilds the universal production addon, starts Electron with an isolated temporary
`userData` directory, and enforces a 90-second process deadline. It does not package, install, or
sign Buddy.

The Electron scenario verifies:

- the public `NSGlassEffectView` hierarchy through `inspectLiquidGlass`, including content identity,
  native handle roles, wrapper ancestry, and process-global state accounting;
- bounded popup backgrounds grouped through `NSGlassEffectContainerView` in a click-through native
  backing window, including replacement, renderer z-order, input delivery, and teardown;
- idempotent installation, option updates, explicit removal, and restoration of Electron's native
  content view;
- resize, hide/show/focus, and real renderer mouse/keyboard delivery through the native hierarchy;
- renderer crash/reload without losing the AppKit wrapper; and
- repeated install/destroy/recreate cycles with no retained native state.

CI additionally checks both universal Mach-O slices, the deployment target and SDK, weak linking of
the macOS 26 AppKit class, the complete current native export surface, and signatures in the packaged
application. A pre-macOS 26 runner loads the same built addon to prove the weak-linked feature reports
unsupported without crashing.
