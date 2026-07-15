/**
 * M3 capture self-test (CLICKY_CAPTURE_TEST=1): headed verification of the
 * capture pipeline. Writes screenN.jpg + meta.json to CLICKY_CAPTURE_OUT,
 * prints the display dump and capture timing, then quits. Two extra windows
 * prove the content-protection self-exclusion: a protected red window (must
 * be ABSENT from the jpeg) and an exempted lime control window (must be
 * VISIBLE). index.ts runs this as the very last boot step; it is dead code in
 * normal runs.
 */

import { app, BrowserWindow, screen } from 'electron';
import { TASKBAR_SAFE_TOPMOST_LEVEL } from './windows/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureAllDisplays, exemptFromCaptureProtection } from './capture';
import { captureTestOutDir } from './env';

export async function runCaptureSelfTest(): Promise<void> {
  // CLICKY_CAPTURE_OUT is the raw env value on purpose: an explicit empty
  // string is respected (documented inconsistency, see env.ts).
  const outDir = captureTestOutDir() ?? join(app.getPath('temp'), 'clicky-capture-test');
  mkdirSync(outDir, { recursive: true });

  const makeTestWin = (x: number, y: number, color: string, label: string): BrowserWindow => {
    const win = new BrowserWindow({
      x,
      y,
      width: 640,
      height: 420,
      frame: false,
      skipTaskbar: true,
      focusable: false,
    });
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
    void win.loadURL(
      `data:text/html,<body style="margin:0;background:${color};color:black;` +
        `font:bold 90px sans-serif;display:grid;place-items:center">${label}</body>`,
    );
    return win;
  };
  const protectedWin = makeTestWin(120, 160, 'red', 'PROTECTED');
  protectedWin.setContentProtection(true);
  const controlWin = makeTestWin(820, 160, 'lime', 'CONTROL');
  exemptFromCaptureProtection(controlWin);

  // Let the overlays and test windows paint before grabbing.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const displayDump = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
  }));
  console.log('[self-test] displays:', JSON.stringify(displayDump, null, 2));

  const t0 = performance.now();
  const results = await captureAllDisplays();
  const elapsedMs = Math.round(performance.now() - t0);
  console.log(`[self-test] captured ${results.length} display(s) in ${elapsedMs}ms`);

  for (const r of results) {
    writeFileSync(
      join(outDir, `screen${r.meta.screenIndex}.jpg`),
      Buffer.from(r.jpegBase64, 'base64'),
    );
  }
  writeFileSync(
    join(outDir, 'meta.json'),
    JSON.stringify(
      { elapsedMs, captures: results.map((r) => r.meta), displays: displayDump },
      null,
      2,
    ),
  );
  console.log(`[self-test] wrote output to ${outDir}`);
  protectedWin.destroy();
  controlWin.destroy();
  app.quit();
}
