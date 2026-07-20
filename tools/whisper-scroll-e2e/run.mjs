#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const packagedExecutable = process.env.BUDDY_WHISPER_E2E_EXECUTABLE;
const sourceApp = process.env.BUDDY_WHISPER_E2E_SOURCE_APP === '1';
const executable = packagedExecutable ?? electronExecutable(repo);
const entryArgs = packagedExecutable ? [] : sourceApp ? [repo] : [join(here, 'main.cjs')];
const userData = mkdtempSync(join(tmpdir(), 'buddy-whisper-scroll-e2e-'));
const port = await availablePort();
const launchArgs = [...entryArgs, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`];
const logs = [];
async function main() {
  let appProcess;
  let cdp;
  try {
    appProcess = spawn(executable, launchArgs, {
      cwd: repo,
      env: {
        ...process.env,
        CLICKY_DEBUG: '0',
        BUDDY_WHISPER_E2E_USER_DATA: userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    capture(appProcess.stdout, logs);
    capture(appProcess.stderr, logs);

    await waitFor(
      async () => {
        const targets = await readTargets(port);
        return targets.some((target) => target.type === 'page' && isWhisperTarget(target.url));
      },
      20_000,
      'Whisper renderer did not start',
    );

    if (packagedExecutable || sourceApp) {
      await runSecondInstance(executable, [...entryArgs, `--user-data-dir=${userData}`]);
    }

    const target = await waitFor(
      async () => {
        const targets = await readTargets(port);
        return targets.find(
          (candidate) => candidate.type === 'page' && isWhisperTarget(candidate.url),
        );
      },
      10_000,
      'Whisper renderer target disappeared',
    );
    cdp = await CdpConnection.open(target.webSocketDebuggerUrl);
    await waitFor(
      async () =>
        cdp
          .evaluate(
            `Boolean(document.querySelector('.stack-content') && document.querySelector('.composer') && document.querySelector('.foot'))`,
          )
          .catch(() => false),
      10_000,
      'Whisper shell did not render',
    );
    await cdp.call('Page.bringToFront');

    const result = await exerciseWhisper(cdp);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\nWHISPER_SCROLL_E2E PASS\n`);
    return true;
  } catch (error) {
    console.error('WHISPER_SCROLL_E2E FAIL');
    console.error(error);
    if (logs.length > 0) console.error(logs.join('').slice(-12_000));
    return false;
  } finally {
    cdp?.close();
    await stopProcess(appProcess);
    rmSync(userData, { recursive: true, force: true });
  }
}

async function exerciseWhisper(connection) {
  const initial = await connection.evaluate(`(() => {
    const stack = document.querySelector('.stack');
    const content = document.querySelector('.stack-content');
    const composer = document.querySelector('.composer');
    const foot = document.querySelector('.foot');
    if (!stack || !content || !composer || !foot) throw new Error('Whisper shell is incomplete');
    content.innerHTML = '<div class="turn" data-role="assistant">CaseSensitive/Path/README.md</div>';
    return true;
  })()`);
  assert(initial === true, 'could not stage the short-history fixture');
  await delay(100);

  const short = await metrics(connection);
  assert(short.scrollHeight === short.clientHeight, 'short history unexpectedly overflows');
  assert(
    Math.abs(short.lastBottom - short.stackBottom) <= 10,
    'short history is not bottom-aligned',
  );
  assert(short.turnText === 'CaseSensitive/Path/README.md', 'transcript casing was changed');
  assert(short.turnTextTransform === 'none', 'transcript has a visual case transform');

  await connection.evaluate(`(() => {
    const content = document.querySelector('.stack-content');
    window.__buddyWheelDeltas = [];
    document.querySelector('.stack').addEventListener('wheel', (event) => window.__buddyWheelDeltas.push(event.deltaY), true);
    const copy = 'a long reply line that must remain reachable while scrolling. '.repeat(7);
    content.innerHTML = Array.from({ length: 6 }, (_, index) =>
      '<div class="turn" data-role="' + (index % 2 === 0 ? 'user' : 'assistant') + '">' +
      'turn ' + (index + 1) + ' — ' + copy + '</div>'
    ).join('');
  })()`);
  const dense = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.maxScrollTop > 400 && atBottom(current) ? current : null;
    },
    2_000,
    'dense history did not settle at the latest reply',
  );
  assert(dense.maxScrollTop > 400, 'dense history has no meaningful scroll range');
  assert(atBottom(dense), 'dense history did not initially follow the latest reply');
  assert(dense.firstTop < dense.stackTop, 'dense history did not overflow above the viewport');

  const point = { x: dense.stackLeft + dense.stackWidth / 2, y: dense.stackTop + 80 };
  const composerBeforeScroll = dense.composer;
  await connection.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: -3,
  });
  const afterTinyWheel = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollTop < dense.scrollTop - 1 ? current : null;
    },
    2_000,
    'small upward trackpad input did not move the history',
  );
  assert(
    afterTinyWheel.scrollTop < dense.scrollTop,
    'small upward trackpad input did not move the history',
  );

  await connection.evaluate(
    `document.querySelector('.stack-content').lastElementChild.append(' ${'streaming token '.repeat(30)}')`,
  );
  await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollHeight > afterTinyWheel.scrollHeight ? current : null;
    },
    2_000,
    'streaming fixture did not grow',
  );
  await delay(100);
  const afterStreamWhileReading = await metrics(connection);
  assert(
    !atBottom(afterStreamWhileReading),
    `streaming content pulled a reader back to the bottom after upward intent: ${JSON.stringify({ dense, afterTinyWheel, afterStreamWhileReading })}`,
  );
  assertRectEqual(
    composerBeforeScroll,
    afterStreamWhileReading.composer,
    'composer moved while the transcript scrolled',
  );

  await connection.evaluate(`document.querySelector('.stack').focus()`);
  await connection.call('Page.bringToFront');
  const beforePageUp = await metrics(connection);
  await key(connection, 'PageUp', 33, 116);
  const afterPageUp = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollTop < beforePageUp.scrollTop - 20 ? current : null;
    },
    2_000,
    'PageUp did not move through the history',
  );
  await key(connection, 'PageDown', 34, 121);
  await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollTop > afterPageUp.scrollTop + 20 ? current : null;
    },
    2_000,
    'PageDown did not move through the history',
  );
  await key(connection, 'Home', 36, 115);
  const afterHome = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollTop <= 2 ? current : null;
    },
    2_000,
    'Home did not expose the oldest reply',
  );
  assert(afterHome.scrollTop <= 2, 'Home did not expose the oldest reply');
  assert(
    Math.abs(afterHome.firstTop - afterHome.stackTop) <= 2,
    'oldest reply is clipped at the top',
  );
  assert(afterHome.outlineStyle === 'none', 'conversation focus painted an outline');
  assert(afterHome.boxShadow === 'none', 'conversation focus painted a focus ring shadow');

  await connection.call('Page.bringToFront');
  await key(connection, 'End', 35, 119);
  const afterEnd = await waitFor(
    async () => {
      const current = await metrics(connection);
      return atBottom(current) ? current : null;
    },
    2_000,
    'End did not return to the latest reply',
  );
  assert(atBottom(afterEnd), 'End did not return to the latest reply');

  await connection.evaluate(
    `document.querySelector('.stack-content').lastElementChild.append(' ${'new token '.repeat(30)}')`,
  );
  const afterStreamAtBottom = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.scrollHeight > afterEnd.scrollHeight && atBottom(current) ? current : null;
    },
    2_000,
    'streaming stopped following after returning to the bottom',
  );
  assert(
    atBottom(afterStreamAtBottom),
    'streaming stopped following after returning to the bottom',
  );

  await connection.evaluate(`document.querySelector('.composer textarea').style.height = '72px'`);
  const afterComposerGrowth = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.clientHeight < afterStreamAtBottom.clientHeight && atBottom(current)
        ? current
        : null;
    },
    2_000,
    'composer growth unpinned the latest reply',
  );
  assert(atBottom(afterComposerGrowth), 'composer growth unpinned the latest reply');

  await connection.evaluate(`document.querySelector('.composer textarea').style.height = '18px'`);
  const afterComposerShrink = await waitFor(
    async () => {
      const current = await metrics(connection);
      return current.clientHeight > afterComposerGrowth.clientHeight && atBottom(current)
        ? current
        : null;
    },
    2_000,
    'composer shrink unpinned the latest reply',
  );

  await connection.evaluate(`(() => {
    const whisper = document.querySelector('.whisper');
    const composer = document.querySelector('.composer');
    const foot = document.querySelector('.foot');
    const cards = document.createElement('div');
    cards.className = 'filesystem-cards';
    cards.innerHTML = '<section class="filesystem-card"><p>${'task status '.repeat(40)}</p></section>'.repeat(3);
    whisper.insertBefore(cards, composer);
    const folder = document.createElement('div');
    folder.className = 'folder-chip';
    folder.innerHTML = '<span class="folder-copy"><strong>CaseSensitiveFolder</strong><span>host filesystem</span></span>';
    whisper.insertBefore(folder, composer);
    const alerts = document.createElement('div');
    alerts.className = 'alerts';
    alerts.innerHTML = '<div class="settings-error" role="alert">${'bounded error detail '.repeat(20)}</div>'.repeat(2);
    whisper.insertBefore(alerts, foot);
  })()`);
  await delay(100);
  const crowded = await metrics(connection);
  assert(crowded.stackHeight >= 48, 'dense state collapsed the conversation history');
  assert(crowded.composer.top >= crowded.stackBottom, 'composer overlaps the history');
  assert(crowded.foot.bottom <= crowded.whisperBottom, 'footer is clipped by the window');
  assert(crowded.documentScrollHeight === crowded.documentClientHeight, 'Whisper shell overflowed');

  return {
    target: dense.url,
    nativeGlass: dense.nativeGlass,
    scrollRange: dense.maxScrollTop,
    tinyTrackpadMovement: dense.scrollTop - afterTinyWheel.scrollTop,
    oldestReachable: afterHome.scrollTop <= 2,
    newestReachable: atBottom(afterEnd),
    streamingPositionPreserved: !atBottom(afterStreamWhileReading),
    resizeFollowedLatest: atBottom(afterComposerGrowth),
    resizeExpansionFollowedLatest: atBottom(afterComposerShrink),
    focusOutline: afterHome.outlineStyle,
    denseStateFits: crowded.foot.bottom <= crowded.whisperBottom,
  };
}

async function metrics(connection) {
  return connection.evaluate(`(() => {
    const stack = document.querySelector('.stack');
    const content = document.querySelector('.stack-content');
    const first = content.firstElementChild;
    const last = content.lastElementChild;
    const composer = document.querySelector('.composer');
    const foot = document.querySelector('.foot');
    const whisper = document.querySelector('.whisper');
    const stackRect = stack.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const footRect = foot.getBoundingClientRect();
    const whisperRect = whisper.getBoundingClientRect();
    const style = getComputedStyle(stack);
    return {
      url: location.href,
      nativeGlass: document.documentElement.dataset.nativeGlass === 'true',
      scrollTop: stack.scrollTop,
      scrollHeight: stack.scrollHeight,
      clientHeight: stack.clientHeight,
      maxScrollTop: stack.scrollHeight - stack.clientHeight,
      stackTop: stackRect.top,
      stackBottom: stackRect.bottom,
      stackLeft: stackRect.left,
      stackWidth: stackRect.width,
      stackHeight: stackRect.height,
      firstTop: first.getBoundingClientRect().top,
      lastBottom: last.getBoundingClientRect().bottom,
      composer: rect(composerRect),
      foot: rect(footRect),
      whisperBottom: whisperRect.bottom,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      turnText: first.textContent,
      turnTextTransform: getComputedStyle(first).textTransform,
      documentScrollHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      wheelDeltas: window.__buddyWheelDeltas ?? [],
    };
    function rect(value) {
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
    }
  })()`);
}

function atBottom(value) {
  return value.maxScrollTop - Math.max(0, value.scrollTop) <= 1;
}

function assertRectEqual(left, right, message) {
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert(Math.abs(left[key] - right[key]) <= 0.5, `${message}: ${key} changed`);
  }
}

async function key(connection, keyName, windowsVirtualKeyCode, nativeVirtualKeyCode) {
  const common = {
    key: keyName,
    code: keyName,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
  };
  await connection.call('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  await connection.call('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

class CdpConnection {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? 'renderer evaluation failed',
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function readTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.ok ? response.json() : [];
  } catch {
    return [];
  }
}

function isWhisperTarget(url) {
  return /\/whisper\/index\.html(?:\?|$)/.test(url);
}

async function runSecondInstance(command, args) {
  const child = spawn(command, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  capture(child.stdout, output);
  capture(child.stderr, output);
  const code = await waitForExit(child, 10_000);
  if (code !== 0) throw new Error(`second instance exited ${code}: ${output.join('')}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000).catch(() => {});
  }
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${timeout}ms`)),
      timeout,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capture(stream, target) {
  stream?.on('data', (chunk) => target.push(chunk.toString()));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error('could not reserve a DevTools port');
  return port;
}

function electronExecutable(root) {
  const executablePath = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron',
  );
  if (!existsSync(executablePath))
    throw new Error(`Electron executable is missing: ${executablePath}`);
  return executablePath;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (!(await main())) process.exit(1);
