'use strict';

const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const WINDOW_LOAD_TIMEOUT_MS = 10_000;
const WINDOW_EVENT_TIMEOUT_MS = 5_000;
const CYCLE_COUNT = 5;
const REQUIRED_EXPORTS = [
  'inspectLiquidGlass',
  'inspectLiquidGlassRegions',
  'installLiquidGlass',
  'removeLiquidGlass',
  'setLiquidGlassRegions',
  'supportsLiquidGlass',
  'updateLiquidGlass',
];

let bridge;
let rendererInputSequence = 0;

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

app.setPath('userData', requiredEnvironment('BUDDY_LIQUID_GLASS_E2E_USER_DATA'));
app.on('window-all-closed', () => {
  // The lifecycle suite deliberately reaches zero windows between cleanup cycles.
});

app.whenReady().then(run).catch(fail);

async function run() {
  bridge = require(requiredEnvironment('BUDDY_LIQUID_GLASS_E2E_ADDON'));
  for (const name of REQUIRED_EXPORTS) {
    assert(typeof bridge[name] === 'function', `native bridge export ${name} is missing`);
  }
  assert(bridge.supportsLiquidGlass() === true, 'macOS 26 runtime did not expose Liquid Glass');

  await exerciseRepeatedCleanup();
  await exerciseRegionLifecycle();
  // Keep the intentional renderer crash last. Electron's macOS process pool can reject a new
  // renderer immediately after a force-crash, which is unrelated to AppKit wrapper cleanup.
  await exerciseFullLifecycle();

  writeFileSync(requiredEnvironment('BUDDY_LIQUID_GLASS_E2E_SENTINEL'), 'complete\n', {
    flag: 'wx',
  });
  app.exit(0);
}

async function exerciseFullLifecycle() {
  const win = await createWindow('full lifecycle');
  const originalHandle = win.getNativeWindowHandle();
  const pristineInspection = bridge.inspectLiquidGlass(originalHandle);
  assertPristine(pristineInspection, 'pristine window', {
    width: 420,
    height: 220,
  });

  const initialOptions = JSON.stringify({
    style: 'regular',
    cornerRadius: 18,
    tintColor: '#33669980',
  });
  assert(bridge.installLiquidGlass(originalHandle, initialOptions) === true, 'install failed');

  const wrapperHandle = win.getNativeWindowHandle();
  if (process.env.BUDDY_LIQUID_GLASS_E2E_DIAGNOSTICS === '1') {
    console.error(
      JSON.stringify({
        browserBounds: win.getBounds(),
        browserContentBounds: win.getContentBounds(),
        pristineInspection,
        installedOriginal: bridge.inspectLiquidGlass(originalHandle),
        installedWrapper: bridge.inspectLiquidGlass(wrapperHandle),
      }),
    );
  }
  assert(
    !wrapperHandle.equals(originalHandle),
    'Electron did not expose the installed glass wrapper',
  );
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'installed original handle', {
    role: 'electron',
    style: 'regular',
    cornerRadius: 18,
    tintColor: '#33669980',
    width: 420,
    height: 220,
  });
  assertInstalled(bridge.inspectLiquidGlass(wrapperHandle), 'installed wrapper handle', {
    role: 'wrapper',
    style: 'regular',
    cornerRadius: 18,
    tintColor: '#33669980',
    width: 420,
    height: 220,
  });

  assert(
    bridge.installLiquidGlass(wrapperHandle, initialOptions) === true,
    'idempotent reinstall failed',
  );
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'idempotent reinstall', {
    role: 'electron',
    style: 'regular',
    cornerRadius: 18,
    tintColor: '#33669980',
    width: 420,
    height: 220,
  });

  assert(
    bridge.updateLiquidGlass(
      wrapperHandle,
      JSON.stringify({ style: 'clear', cornerRadius: 24, tintColor: null }),
    ) === true,
    'update failed',
  );
  assertInstalled(bridge.inspectLiquidGlass(wrapperHandle), 'updated wrapper', {
    role: 'wrapper',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 420,
    height: 220,
  });

  await showAndFocus(win);
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'shown and focused', {
    role: 'electron',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 420,
    height: 220,
  });

  await resize(win, { width: 460, height: 250 });
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'resized', {
    role: 'electron',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 460,
    height: 250,
  });

  win.hide();
  await waitUntil(() => !win.isVisible(), 'window did not hide');
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'hidden', {
    role: 'electron',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 460,
    height: 250,
  });
  await showAndFocus(win);
  await assertRendererInput(win);

  const crashed = onceWithTimeout(win.webContents, 'render-process-gone', WINDOW_LOAD_TIMEOUT_MS);
  win.webContents.forcefullyCrashRenderer();
  await crashed;
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'renderer crashed', {
    role: 'electron',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 460,
    height: 250,
  });

  const reloaded = onceWithTimeout(win.webContents, 'did-finish-load', WINDOW_LOAD_TIMEOUT_MS);
  win.webContents.reload();
  await reloaded;
  assertInstalled(bridge.inspectLiquidGlass(originalHandle), 'renderer reloaded', {
    role: 'electron',
    style: 'clear',
    cornerRadius: 24,
    tintColor: null,
    width: 460,
    height: 250,
  });
  await showAndFocus(win);
  await assertRendererInput(win);

  assert(bridge.removeLiquidGlass(wrapperHandle) === true, 'remove failed');
  const removedInspection = bridge.inspectLiquidGlass(originalHandle);
  assertPristine(removedInspection, 'removed window', {
    width: 460,
    height: 250,
  });
  assert(
    removedInspection.nativeViewAutoresizingMask === pristineInspection.nativeViewAutoresizingMask,
    'remove did not restore the Electron view autoresizing mask',
  );
  assert(
    win.getNativeWindowHandle().equals(originalHandle),
    'Electron native handle was not restored after removal',
  );
  await assertRendererInput(win);
  await destroyWindow(win);
}

async function exerciseRegionLifecycle() {
  const win = await createWindow('bounded regions');
  const originalHandle = win.getNativeWindowHandle();
  const payload = JSON.stringify({
    spacing: 12,
    regions: [
      {
        id: 'hover-hint',
        x: 20,
        y: 18,
        width: 180,
        height: 64,
        style: 'regular',
        cornerRadius: 14,
        tintColor: '#11182773',
      },
      {
        id: 'helper-card',
        x: 216,
        y: 36,
        width: 180,
        height: 150,
        style: 'regular',
        cornerRadius: 16,
        tintColor: null,
      },
    ],
  });
  assert(bridge.setLiquidGlassRegions(originalHandle, payload) === true, 'region install failed');
  const wrapperHandle = win.getNativeWindowHandle();
  assert(
    wrapperHandle.equals(originalHandle),
    "bounded glass replaced Electron's native content handle",
  );
  assertRegionInspection(bridge.inspectLiquidGlassRegions(originalHandle), 2, 'region install');
  assertRegionInspection(bridge.inspectLiquidGlassRegions(wrapperHandle), 2, 'region wrapper');
  await showAndFocus(win);
  await assertRendererInput(win);

  assert(
    bridge.setLiquidGlassRegions(
      wrapperHandle,
      JSON.stringify({
        spacing: 12,
        regions: [
          {
            id: 'helper-card',
            x: 124,
            y: 24,
            width: 264,
            height: 170,
            style: 'regular',
            cornerRadius: 16,
            tintColor: '#11182773',
          },
        ],
      }),
    ) === true,
    'region update failed',
  );
  assertRegionInspection(bridge.inspectLiquidGlassRegions(wrapperHandle), 1, 'region update');
  await destroyWindow(win);

  const finalWindow = await createWindow('post-region cleanup');
  assertDeepEqual(
    bridge.inspectLiquidGlassRegions(finalWindow.getNativeWindowHandle()),
    {
      supported: true,
      installed: false,
      activeStateCount: 0,
      regionCount: 0,
      hierarchyValid: false,
      electronAboveRegions: false,
      containerClass: null,
    },
    'post-region cleanup',
  );
  await destroyWindow(finalWindow);
}

async function exerciseRepeatedCleanup() {
  for (let index = 0; index < CYCLE_COUNT; index += 1) {
    const win = await createWindow(`cleanup cycle ${index + 1}`);
    const originalHandle = win.getNativeWindowHandle();
    assertPristine(bridge.inspectLiquidGlass(originalHandle), `cycle ${index + 1} pristine`, {
      width: 420,
      height: 220,
    });
    assert(
      bridge.installLiquidGlass(
        originalHandle,
        JSON.stringify({ style: 'regular', cornerRadius: 12 + index, tintColor: null }),
      ) === true,
      `cycle ${index + 1} install failed`,
    );
    assertInstalled(bridge.inspectLiquidGlass(originalHandle), `cycle ${index + 1} installed`, {
      role: 'electron',
      style: 'regular',
      cornerRadius: 12 + index,
      tintColor: null,
      width: 420,
      height: 220,
    });
    await destroyWindow(win);
  }

  const finalWindow = await createWindow('post-cycle cleanup');
  assertPristine(
    bridge.inspectLiquidGlass(finalWindow.getNativeWindowHandle()),
    'post-cycle cleanup',
    { width: 420, height: 220 },
  );
  await destroyWindow(finalWindow);
}

async function createWindow(label) {
  const win = new BrowserWindow({
    width: 420,
    height: 220,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await promiseWithTimeout(
      win.loadFile(join(__dirname, 'fixture.html')),
      WINDOW_LOAD_TIMEOUT_MS,
      `${label} renderer load`,
    );
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw new Error(`${label} renderer failed to load`, { cause: error });
  }
  return win;
}

async function showAndFocus(win) {
  win.show();
  win.focus();
  win.webContents.focus();
  await waitUntil(
    () => win.isVisible() && win.isFocused(),
    'window did not become visible and focused',
  );
}

async function resize(win, size) {
  const current = win.getBounds();
  const resized = onceWithTimeout(win, 'resize', WINDOW_EVENT_TIMEOUT_MS);
  win.setBounds({ ...current, ...size });
  await resized;
  const bounds = win.getBounds();
  assert(
    bounds.width === size.width && bounds.height === size.height,
    'window resize did not persist',
  );
}

async function assertRendererInput(win) {
  const character = String.fromCharCode(97 + (rendererInputSequence % 26));
  rendererInputSequence += 1;
  const baseline = await win.webContents.executeJavaScript(`(() => {
    const scrollTarget = document.getElementById('scroll-target');
    scrollTarget.scrollTop = 0;
    document.getElementById('target').focus();
    return {
      events: { ...window.__buddyEvents },
      value: document.getElementById('target').value,
      scrollTop: scrollTarget.scrollTop,
    };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 30, y: 30 });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: 30,
    y: 30,
    button: 'left',
    clickCount: 1,
  });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: character.toUpperCase() });
  win.webContents.sendInputEvent({ type: 'char', keyCode: character });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: character.toUpperCase() });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 320, y: 80 });
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: 320, y: 80, deltaY: -120 });
  let latestState;
  try {
    await waitUntil(async () => {
      latestState = await win.webContents.executeJavaScript(`({
        events: window.__buddyEvents,
        value: document.getElementById('target').value,
        scrollTop: document.getElementById('scroll-target').scrollTop,
      })`);
      return (
        latestState.events.mouseDown > baseline.events.mouseDown &&
        latestState.events.keyDown > baseline.events.keyDown &&
        latestState.events.input > baseline.events.input &&
        latestState.events.scroll > baseline.events.scroll &&
        latestState.value.length === baseline.value.length + 1 &&
        latestState.value.includes(character) &&
        latestState.scrollTop > baseline.scrollTop
      );
    }, 'renderer did not receive fresh mouse, keyboard, and wheel input through the glass hierarchy');
  } catch (error) {
    throw new Error(
      `renderer input did not advance from ${JSON.stringify(baseline)} to ${JSON.stringify(latestState)}`,
      { cause: error },
    );
  }
}

async function destroyWindow(win) {
  const rendererProcessId = win.webContents.getOSProcessId();
  assert(rendererProcessId > 0, 'window did not have a live renderer process before destruction');
  const closed = onceWithTimeout(win, 'closed', WINDOW_EVENT_TIMEOUT_MS);
  win.destroy();
  await closed;
  await waitUntil(
    () => !app.getAppMetrics().some((metric) => metric.pid === rendererProcessId),
    `renderer process ${rendererProcessId} did not exit after window destruction`,
  );
}

function assertPristine(actual, label, dimensions) {
  const { nativeViewFrame, nativeViewAutoresizingMask, ...core } = actual;
  assertDeepEqual(
    core,
    {
      supported: true,
      installed: false,
      activeStateCount: 0,
      wrapperClass: null,
      nativeHandleRole: 'unmanaged',
      contentMatchesElectronView: false,
      sameWindow: false,
      hierarchyDepth: 0,
      style: null,
      cornerRadius: null,
      tintColor: null,
    },
    label,
  );
  assertNativeViewGeometry(nativeViewFrame, nativeViewAutoresizingMask, dimensions, label);
}

function assertInstalled(actual, label, expected) {
  const { nativeViewFrame, nativeViewAutoresizingMask, hierarchyDepth, ...core } = actual;
  assertDeepEqual(
    core,
    {
      supported: true,
      installed: true,
      activeStateCount: 1,
      wrapperClass: 'NSGlassEffectView',
      nativeHandleRole: expected.role,
      contentMatchesElectronView: true,
      sameWindow: true,
      style: expected.style,
      cornerRadius: expected.cornerRadius,
      tintColor: expected.tintColor,
    },
    label,
  );
  assert(
    Number.isSafeInteger(hierarchyDepth) && hierarchyDepth >= 1,
    `${label}: Electron content is not a descendant of the glass wrapper`,
  );
  assertNativeViewGeometry(nativeViewFrame, nativeViewAutoresizingMask, expected, label);
}

function assertNativeViewGeometry(frame, autoresizingMask, expected, label) {
  assert(
    typeof frame === 'object' &&
      frame !== null &&
      Number.isFinite(frame.x) &&
      Number.isFinite(frame.y) &&
      frame.width === expected.width &&
      frame.height === expected.height,
    `${label}: native view does not fill the expected ${expected.width}x${expected.height} content area: ${JSON.stringify(frame)}`,
  );
  assert(
    Number.isSafeInteger(autoresizingMask) && autoresizingMask >= 0,
    `${label}: native view has an invalid autoresizing mask`,
  );
}

function assertRegionInspection(actual, regionCount, label) {
  assertDeepEqual(
    actual,
    {
      supported: true,
      installed: true,
      activeStateCount: 1,
      regionCount,
      hierarchyValid: true,
      electronAboveRegions: true,
      containerClass: 'NSGlassEffectContainerView',
    },
    label,
  );
}

function assertDeepEqual(actual, expected, label) {
  const actualJSON = JSON.stringify(actual);
  const expectedJSON = JSON.stringify(expected);
  assert(actualJSON === expectedJSON, `${label}: expected ${expectedJSON}, received ${actualJSON}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, failureMessage) {
  const deadline = Date.now() + WINDOW_EVENT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failureMessage, lastError === undefined ? undefined : { cause: lastError });
}

function onceWithTimeout(emitter, eventName, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(eventName, onEvent);
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeout);
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    emitter.once(eventName, onEvent);
  });
}

function promiseWithTimeout(promise, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function fail(error) {
  console.error('LIQUID_GLASS_E2E FAIL');
  console.error(error);
  app.exit(1);
}
