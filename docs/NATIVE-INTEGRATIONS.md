# Native platform integrations

This note records the native platform decisions behind accessibility grounding, live-desktop
input, macOS presentation, and release verification. Product-facing behavior is shared; native
code stays behind small providers.

## Accessibility: one contract, two providers

Accessibility trees are not cross-platform APIs. macOS exposes AXUIElement and
Quartz window metadata; Windows exposes UI Automation and Win32 window/DPI
metadata. Buddy shares orchestration rather than pretending the
native trees are identical:

```ts
interface ElementGrounder {
  readonly provider: 'ax' | 'uia';
  warmUp(): void;
  snap(
    query: ElementGroundingQuery,
    options?: { debug?: boolean; timeboxMs?: number },
  ): Promise<ElementGroundingOutcome>;
  dispose(): void;
}
```

`ElementGroundingQuery` and `ElementGroundingOutcome` use **global DIP**. Shared TypeScript
owns label normalization/scoring, time budgets, cancellation, telemetry, and
the REST/raw fallback. Providers own permission checks, native enumeration,
window-stack lookup, and native coordinate conversion.

The implemented providers are:

- macOS: AXUIElement for elements and `CGWindowListCopyWindowInfo` for the
  on-screen front-to-back window scene.
- Windows: UI Automation for elements and Win32 (`EnumWindows`,
  `WindowFromPoint`, per-monitor DPI APIs) for the window scene.

### Side-by-side and overlapping windows

“Frontmost application” is not a sufficient target: two visible apps can share
a display, and the model point can drift across their divider. At each explicit
grounding request Buddy snapshots the visible window scene. A query
covers the window under the proposed point plus a small set of nearby visible
candidate windows whose bounds intersect the search radius. The shared label
score chooses the result; window order and point proximity are tie-breakers.
Enumeration happens immediately before dispatch, so moved/closed windows are
not selected from a stale startup or frontmost-app cache.

This is bounded to the current request—no continuous screen capture or
accessibility-tree monitoring. Canvas, game, remote-desktop, and unlabeled
custom controls continue through the existing REST vision fallback.

## Live-desktop input: one operator, two controllers

The computer-use operator and `LiveDesktopDriver` are shared. The factory in
`src/main/computer/input-controller.ts` selects one permission-gated native controller:

- macOS: the in-process native bridge posts CoreGraphics mouse, scroll, text, and key events after
  confirming Accessibility trust. Coordinates remain global logical points, matching Electron DIP.
- Windows: the persistent PowerShell input daemon posts Win32 mouse and keyboard input in physical
  screen pixels. Electron owns the DIP-to-physical conversion.

Both implementations use the same explicit Settings opt-in, fresh screenshot after each action,
native focused-receiver evidence, independent review, and one-use human approval contract.
Unsupported platforms fail before an input controller is created.

## Objective-C versus Swift

Swift is the default choice for a new substantial Apple UI layer and is the
forward path for SwiftUI, App Intents, widgets, and other Swift-protocol-heavy
system integrations. Swift 5 has a stable ABI and its runtime ships with Apple
platforms.

Objective-C remains supported and has full access to the AppKit,
ApplicationServices/AX, and CoreGraphics APIs Buddy needs here. For Buddy's
small in-process Electron bridge it is the simpler boundary:

- Node-API is a C ABI, directly callable from an Objective-C `.m` file.
- One `clang` invocation produces the universal `.node` bundle.
- It avoids a Swift-to-C export shim and Swift module/runtime build plumbing.
- AX and screen-geometry capability and performance are the same either way.

Decision: keep the **thin Node-API bridge in Objective-C**. Use Swift when
Buddy gains an Apple-native extension or substantial native UI—especially App
Intents or SwiftUI. Both can coexist in the same product, so this decision does
not lock Buddy out of new Swift-first features.

Relevant primary documentation:

- [Swift ABI stability](https://www.swift.org/blog/abi-stability-and-apple/)
- [SwiftUI](https://developer.apple.com/documentation/swiftui)
- [App Intents](https://developer.apple.com/documentation/appintents)
- [Objective-C runtime](https://developer.apple.com/documentation/objectivec)
- [AX hit testing](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)
- [Quartz window list](<https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)>)
- [NSScreen safe areas](https://developer.apple.com/documentation/appkit/nsscreen)

## Buddy Live Bar / Buddy Island

The Live Bar is rendered inside the existing per-display transparent overlay;
it is not another native window. The overlay remains non-focusable and
click-through. On a notched built-in display, AppKit safe-area geometry places
two black wings flush against the sides of the physical notch — the activity
orb on the left, the status label on the right. AppKit only exposes the
notch's rectangular bounding box (`safeAreaInsets` + `auxiliaryTop*Area`, no
corner-radius API), and the physical cutout is rounded inside it, so a cover
paints the whole box black to keep the wings and cutout visually seamless. On
non-notched Macs and external displays it becomes a detached capsule below the
menu bar. It is off
on Windows for now; a tray/taskbar-native Windows surface can implement the
same shared activity model later.

Electron deliberately clamps ordinary macOS `BrowserWindow` coordinates below
the menu bar. The native bridge therefore marks only Buddy overlay window
instances and bypasses `NSWindow.constrainFrameRect` for those instances. The
overlay can cover the physical `NSScreen.frame`; every other Electron window
continues through AppKit's original constraint. The bridge also reasserts
`ignoresMouseEvents`, the screen-saver window level, and no shadow. Main-process
pointer and hover math uses the physical display bounds whenever this placement
succeeds, so removing the 30–40 point clamp does not shift pointing.

Only the overlay currently hosting Buddy renders the Live Bar, so a
multi-display setup never shows duplicate status. Activity priority is capture
privacy → conversation → running helper buddies → unseen result. Idle is hidden; a new
result expands briefly and then collapses to a persistent dot until viewed.

## Native verification

- `npm test` runs the shared contract, scorer, coordinate, Island-state, and
  display-surface tests on every platform.
- `BUDDY_WINDOWS_UIA_E2E=1 npm run test:uia:win` opens two real side-by-side WPF
  windows and requires the production UIA daemon to select a named control in
  the adjacent window rather than the window under the proposed point.
- `.github/workflows/native-platform-verification.yml` runs the native Windows
  test, both full suites/builds, universal macOS bridge checks, and unsigned QA
  packaging on hosted Windows and macOS machines.
- In a debug-enabled app, `GET /hover/state` reports the actual overlay bounds,
  per-display surface decision, and `nativeFullDisplay` placement result.

`npm run dist` is explicitly non-publishing. The signing hook rejects ad-hoc
macOS artifacts unless `BUDDY_ALLOW_ADHOC=1` is deliberately set for disposable
QA. QA packages use a separate entitlement file because an ad-hoc outer bundle
must load Electron frameworks carrying a different upstream Team ID.

The project-owned macOS signer preserves the exact SHA-1 identity fingerprint
resolved by electron-builder, so duplicate certificate display names cannot make
`codesign` ambiguous. Release operators may additionally pin that fingerprint
with `BUDDY_MAC_SIGNING_IDENTITY_SHA1`; a mismatch fails before an artifact is
created.

`npm run dist:release:mac` is the production gate. Before building, it requires
a Developer ID Application identity plus one complete electron-builder
notarization credential set (App Store Connect API key, Apple ID credentials,
or a notarytool keychain profile). It forbids the ad-hoc escape hatch, forces
code signing, enables hardened runtime, applies the production JIT and
audio-input entitlements, and submits through electron-builder notarization.
The after-sign hook independently verifies the stable identity, runtime flag,
and required entitlements. Production entitlements deliberately retain library
validation. The needed identity and notary credentials do not exist in this
repository and must remain external secrets.
