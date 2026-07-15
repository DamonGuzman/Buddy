// Spike: validate the offscreen-browser-sandbox mechanisms for helper buddies.
// Design doc: docs/AGENT-SANDBOX.md §2.2 (its results table comes from this script).
// Run: npx electron tools/spikes/offscreen-browser-spike.js
// (Writes spike-capture.png next to this file; verified 2026-07-14 on Electron 43.1.0.)
// Verifies, against a HIDDEN BrowserWindow (show:false, never shown):
//   1. capturePage() returns real painted pixels (not blank)
//   2. CDP input via webContents.debugger clicks a button WITHOUT OS focus
//   3. CDP Input.insertText types into a field
//   4. sendInputEvent (non-CDP fallback) also works hidden
//   5. document.elementFromPoint hit-testing via executeJavaScript
//   6. coordinate scale between capturePage image px and CSS px
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const results = { electron: process.versions.electron };
const fail = (step, err) => {
  results[step] = { ok: false, error: String((err && err.message) || err) };
};

const PAGE = `<!doctype html><html><body style="margin:0;background:#dd3333">
<button id="btn" style="position:absolute;left:100px;top:100px;width:120px;height:40px"
  onclick="document.getElementById('out').textContent='CLICKED'">Submit</button>
<form><input id="inp" style="position:absolute;left:100px;top:200px;width:200px;height:24px"></form>
<div id="out" style="position:absolute;left:100px;top:300px;color:#fff">idle</div>
</body></html>`;

async function main() {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: {
      partition: 'persist:buddy-spike',
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 500)); // let first paint land

  // --- 1. hidden capture ---
  try {
    const img = await wc.capturePage();
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    // sample a pixel in the red background area (CSS 400,450 -> scale)
    const scale = size.width / 800;
    const px = Math.round(400 * scale), py = Math.round(450 * scale);
    const off = (py * size.width + px) * 4;
    const [b, g, rch] = [bmp[off], bmp[off + 1], bmp[off + 2]];
    const painted = rch > 150 && g < 100 && b < 100; // page background is #dd3333
    results.hiddenCapture = {
      ok: !img.isEmpty() && painted,
      imagePx: size,
      cssPx: { width: 800, height: 600 },
      scale,
      sampledBGRA: [b, g, rch],
      painted,
    };
    fs.writeFileSync(path.join(__dirname, 'spike-capture.png'), img.toPNG());
  } catch (e) { fail('hiddenCapture', e); }

  // --- 5. DOM hit-test (do before click so page state is clean) ---
  try {
    const hit = await wc.executeJavaScript(
      `(() => { const el = document.elementFromPoint(160, 120);
        return { tag: el && el.tagName, id: el && el.id, text: el && el.textContent,
                 inForm: !!(el && el.closest('form')) }; })()`
    );
    results.hitTest = { ok: hit && hit.id === 'btn', hit };
  } catch (e) { fail('hitTest', e); }

  // --- 2. CDP click on the hidden, unfocused window ---
  try {
    wc.debugger.attach('1.3');
    const mouse = (type) =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, x: 160, y: 120, button: 'left', clickCount: 1,
      });
    await mouse('mousePressed');
    await mouse('mouseReleased');
    await new Promise((r) => setTimeout(r, 200));
    const out = await wc.executeJavaScript(`document.getElementById('out').textContent`);
    results.cdpClick = { ok: out === 'CLICKED', outText: out, windowVisible: win.isVisible(), windowFocused: win.isFocused() };
  } catch (e) { fail('cdpClick', e); }

  // --- 3. CDP typing: click the input, then insertText ---
  try {
    const mouse = (type) =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, x: 160, y: 212, button: 'left', clickCount: 1,
      });
    await mouse('mousePressed');
    await mouse('mouseReleased');
    await wc.debugger.sendCommand('Input.insertText', { text: 'hello buddy' });
    await new Promise((r) => setTimeout(r, 200));
    const val = await wc.executeJavaScript(`document.getElementById('inp').value`);
    results.cdpType = { ok: val === 'hello buddy', value: val };
  } catch (e) { fail('cdpType', e); }

  // --- 3b. CDP raw key event (Enter/shortcut path) ---
  try {
    const key = (type) =>
      wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'a', code: 'KeyA', text: type === 'keyDown' ? 'a' : undefined,
        windowsVirtualKeyCode: 65,
      });
    await key('keyDown');
    await key('keyUp');
    await new Promise((r) => setTimeout(r, 200));
    const val = await wc.executeJavaScript(`document.getElementById('inp').value`);
    results.cdpKeyEvent = { ok: val === 'hello buddya', value: val };
  } catch (e) { fail('cdpKeyEvent', e); }

  // --- 4. sendInputEvent fallback (non-CDP) ---
  try {
    await wc.executeJavaScript(`document.getElementById('out').textContent = 'idle'`);
    wc.sendInputEvent({ type: 'mouseDown', x: 160, y: 120, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 160, y: 120, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 200));
    const out = await wc.executeJavaScript(`document.getElementById('out').textContent`);
    wc.sendInputEvent({ type: 'char', keyCode: 'z' });
    await new Promise((r) => setTimeout(r, 200));
    const val = await wc.executeJavaScript(`document.getElementById('inp').value`);
    results.sendInputEvent = { ok: out === 'CLICKED', clickOut: out, charLandedInInput: val };
  } catch (e) { fail('sendInputEvent', e); }

  // --- capture again post-interaction to prove repaint while hidden ---
  try {
    const img2 = await wc.capturePage();
    results.recapture = { ok: !img2.isEmpty(), imagePx: img2.getSize() };
  } catch (e) { fail('recapture', e); }

  console.log('SPIKE_RESULTS ' + JSON.stringify(results, null, 2));
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.log('SPIKE_RESULTS ' + JSON.stringify(results));
    console.error('SPIKE_FATAL', e);
    app.exit(1);
  })
);
