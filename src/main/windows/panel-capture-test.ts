/**
 * CLICKY_TEST_CAPTURE=1 QA wiring for the panel window: mirror renderer
 * console lines to stdout and run a start→(6s)→stop capture cycle against the
 * hidden window, so hidden-window mic capture can be verified from a terminal
 * without the hotkey wiring. Extracted from windows/panel.ts — dead code in
 * normal runs.
 */

import type { BrowserWindow } from 'electron';
import type { CaptureControl } from '../../shared/types';

export interface PanelCaptureTestOptions {
  /** CLICKY_TEST_MIC=<label substring>: pre-select that mic first. */
  micLabelSubstring: string | null;
}

export function wireCaptureTest(
  win: BrowserWindow,
  sendCapture: (payload: CaptureControl) => void,
  options: PanelCaptureTestOptions,
): void {
  win.webContents.on('console-message', (details) => {
    console.log(`[panel-console] ${details.message}`);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        // CLICKY_TEST_MIC=<label substring> → select that device first via
        // the real renderer-side flow (enumerateDevices + clicky.selectMic).
        const micMatch = options.micLabelSubstring;
        if (micMatch) {
          const picked: unknown = await win.webContents.executeJavaScript(
            `(async () => {
               const devs = await navigator.mediaDevices.enumerateDevices();
               const m = devs.find(
                 (d) =>
                   d.kind === 'audioinput' &&
                   d.label.toLowerCase().includes(${JSON.stringify(micMatch.toLowerCase())}),
               );
               if (m) await window.clicky.selectMic(m.deviceId);
               return m
                 ? m.label
                 : 'no match in: ' +
                     devs
                       .filter((d) => d.kind === 'audioinput')
                       .map((d) => d.label || d.deviceId)
                       .join(' | ');
             })()`,
          );
          console.log('[capture-test] selected mic:', picked ?? '(no match, using default)');
        }
        console.log(
          '[capture-test] sending audio:capture start (window hidden:',
          !win.isVisible(),
          ')',
        );
        sendCapture({ command: 'start' });
        setTimeout(() => {
          console.log('[capture-test] sending audio:capture stop');
          sendCapture({ command: 'stop' });
          // Phase 2: synthetic tone through the same worklet pipeline
          // (nonzero-signal proof independent of mic hardware).
          setTimeout(() => {
            console.log('[capture-test] starting dev tone capture');
            void win.webContents.executeJavaScript(
              `window.__clickyDev && window.__clickyDev.captureTone()`,
            );
            setTimeout(() => {
              console.log('[capture-test] stopping dev tone capture');
              void win.webContents.executeJavaScript(
                `window.__clickyDev && window.__clickyDev.stopCapture()`,
              );
              // Phase 3: playback QA (gapless + flush + stale-item drop).
              void win.webContents
                .executeJavaScript(
                  `window.__clickyDev ? window.__clickyDev.playbackQa() : 'dev hooks unavailable'`,
                )
                .then((marks) => console.log('[capture-test] playback drain marks (ms):', marks));
            }, 3000);
          }, 1000);
        }, 6000);
      })();
    }, 2500);
  });
}
