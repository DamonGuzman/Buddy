# Throwaway iPhone audio bridge

Disposable QA harness for using an iPhone as Buddy's microphone and speaker.
It is deliberately absent from the product UI. Buddy uses its normal panel
microphone unless the bridge is explicitly selected with
`CLICKY_PHONE_AUDIO_URL=<url>` or the bundled Windows bridge is explicitly
started with `CLICKY_PHONE_AUDIO_AUTOSTART=1`.

## Use

1. Run `npm run phone-audio`.
2. On the iPhone, open the setup URL printed by the command (currently the PC
   is `http://192.168.4.126:3211/`).
3. Download the iPhone profile. Open **Settings > Profile Downloaded** and tap
   **Install** (or find it under **Settings > General > VPN & Device
   Management**). Then enable **Buddy Throwaway Audio CA** under **Settings >
   General > About > Certificate Trust Settings**.
4. Open the secure-page link and tap **connect audio**.
5. Keep Safari open. Hold Ctrl+Alt on the PC, speak, then release.

`npm run phone-audio` stops an already-running `Buddy.exe` so the replacement
process receives the bridge environment variable. Ctrl+C stops the harness.

## QA commands

- `npm run phone-audio:smoke` checks control and PCM relay in both directions.
- `npm run phone-audio:e2e` drives a real Buddy dev instance through the mock
  Realtime server and proves mic PCM enters Buddy and response PCM reaches the
  simulated phone.
- In PowerShell, `$env:CLICKY_PHONE_AUDIO_AUTOSTART='1'; npm run dev` launches
  the bundled bridge and hot-reloading Electron development build together on
  Windows. The bridge remains running while main-process edits restart Electron
  and both stop together on Ctrl+C. Plain `npm run dev` always uses the panel
  microphone.
- Setting `CLICKY_PHONE_AUDIO_URL=<url>` before `npm run dev` connects to an
  externally managed bridge without launching the bundled bridge and works on
  any supported Buddy platform.

## Removal

Delete `tools/phone-audio-bridge`, remove the `phoneAudio` seam in
`src/main/conversation.ts` and `src/main/index.ts`, and remove
`src/main/phone-audio-bridge.ts`. On the iPhone, remove the **Buddy Throwaway
Audio CA** profile.
