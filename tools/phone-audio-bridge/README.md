# Throwaway iPhone audio bridge

Disposable QA harness for using an iPhone as Buddy's microphone and speaker.
It is deliberately absent from the product UI and only activates when
`CLICKY_PHONE_AUDIO_URL` is present.

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
- `npm run phone-audio:dev` launches the Electron development build instead of
  the installed app.

## Removal

Delete `tools/phone-audio-bridge`, remove the `phoneAudio` seam in
`src/main/conversation.ts` and `src/main/index.ts`, and remove
`src/main/phone-audio-bridge.ts`. On the iPhone, remove the **Buddy Throwaway
Audio CA** profile.
