# Browser computer-use Electron verification

Runs the production `OffscreenBrowserDriver` and `BuddyBrowserProfile` inside Electron against
ephemeral localhost fixtures. No API key or external network access is required.

```sh
npm run test:browser
```

The runner builds a dedicated temporary Electron main bundle, launches it with an isolated
`userData` directory, and removes both after the run. It exits non-zero on the first failed
invariant. Coverage includes:

- painted hidden capture and capture-to-CSS coordinate mapping;
- hidden synthetic click plus CDP Unicode typing, key chords, form submission, and scrolling;
- DOM inspection through open shadow DOM and same/cross-origin iframes;
- permission denial, download cancellation, popup denial, and cross-domain navigation blocking;
- visible enrollment sharing the persistent buddy profile with recreated hidden drivers;
- a composed `AgentRunner` flow from capability approval through independent action review,
  one-use human approval, real browser action, fresh evidence capture, and persisted result; and
- browser-window destruction plus fail-fast behavior after disposal.
