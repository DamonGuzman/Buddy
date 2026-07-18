import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow, nativeImage } from 'electron';
import type { DownloadItem } from 'electron';
import { HelperBuddyRunner } from '../../src/main/agents/helper-buddy';
import { HelperBuddyMemoryStore } from '../../src/main/agents/helper-buddy-memory-store';
import { HelperBuddyApprovalCoordinator } from '../../src/main/agents/approvals';
import { ActionGate } from '../../src/main/agents/gate/action-gate';
import {
  ApprovalFollowThroughTracker,
  ApprovalGrantStore,
} from '../../src/main/agents/gate/grants';
import {
  markEvidenceScreenshot,
  type ActionReviewEvidence,
} from '../../src/main/agents/gate/reviewer';
import type {
  HelperBuddyBackend,
  HelperBuddyBackendResult,
  HelperBuddyFilesystemToolPort,
} from '../../src/main/agents/types';
import { OffscreenBrowserDriver } from '../../src/main/computer/browser-driver';
import { BuddyBrowserProfile } from '../../src/main/computer/browser-profile';
import type { CaptureResult } from '../../src/main/capture';
import type { DriverPoint } from '../../src/main/computer/driver';
import type { ElementFacts } from '../../src/main/agents/gate/trigger';

const userData = process.env.BUDDY_BROWSER_E2E_USER_DATA;
if (!userData) throw new Error('BUDDY_BROWSER_E2E_USER_DATA is required');
const sentinel = process.env.BUDDY_BROWSER_E2E_SENTINEL;
if (!sentinel) throw new Error('BUDDY_BROWSER_E2E_SENTINEL is required');
app.setPath('userData', userData);
// Several lifecycle checks intentionally close the last BrowserWindow before
// creating the next driver. The product is a tray app and stays alive in that
// state; mirror that contract so Electron cannot report a false green by
// quitting halfway through the harness.
app.on('window-all-closed', () => undefined);
// The verifier intentionally closes enrollment/driver windows between lifecycle checks.
app.on('window-all-closed', () => undefined);

interface FixtureServers {
  mainOrigin: string;
  crossOrigin: string;
  close(): Promise<void>;
}

interface PagePoint {
  x: number;
  y: number;
}

const runToken = `run-${Date.now()}-${process.pid}`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function html(body: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;min-height:100%;font:16px sans-serif;background:#c92f43;color:#fff}
    button,input,a,#output,#permission-result,#scroll-state,h1{position:absolute;box-sizing:border-box}
    button,input,a{height:42px;padding:8px;background:#fff;color:#111;border:2px solid #111}
  </style></head><body>${body}<script>${script}</script></body></html>`;
}

function controlsPage(): string {
  return html(
    `<button id="click" style="left:80px;top:80px;width:180px">click target</button>
     <div id="output" style="left:80px;top:145px">idle</div>
     <form id="form"><input id="text" style="left:80px;top:220px;width:260px" /></form>
     <div id="scroll-state" style="position:fixed;left:700px;top:25px">not scrolled</div>
     <div style="position:absolute;left:0;top:1600px;width:1px;height:1px"></div>`,
    `document.querySelector('#click').addEventListener('click',()=>document.querySelector('#output').textContent='clicked');
     document.querySelector('#form').addEventListener('submit',(event)=>{event.preventDefault();document.querySelector('#output').textContent='submitted: '+document.querySelector('#text').value});
     addEventListener('scroll',()=>{if(scrollY>300) document.querySelector('#scroll-state').textContent='scrolled'});`,
  );
}

function framesPage(crossOrigin: string): string {
  return html(
    `<div id="shadow" style="position:absolute;left:70px;top:70px;width:240px;height:100px"></div>
     <iframe id="same" name="buddy-same-frame" src="/same-frame" style="position:absolute;left:50px;top:250px;width:320px;height:160px;border:0"></iframe>
     <iframe id="cross" name="buddy-cross-frame" src="${crossOrigin}/cross-frame" style="position:absolute;left:450px;top:250px;width:320px;height:160px;border:0"></iframe>`,
    `const root=document.querySelector('#shadow').attachShadow({mode:'open'});
     root.innerHTML='<button style="position:absolute;left:20px;top:20px;width:180px;height:42px">shadow target</button>';`,
  );
}

function framePage(label: string): string {
  return html(`<button style="left:40px;top:30px;width:200px">${label}</button>`);
}

function securityPage(crossOrigin: string): string {
  return html(
    `<h1 style="left:400px;top:40px">security surface</h1>
     <button id="permission" style="left:70px;top:70px;width:220px">request location</button>
     <div id="permission-result" style="left:70px;top:135px">permission idle</div>
     <a id="download" href="/download" style="left:70px;top:220px;width:220px">download target</a>
     <button id="popup" style="left:70px;top:320px;width:220px">open popup</button>
     <a id="cross-nav" href="${crossOrigin}/cross-landing" style="left:70px;top:420px;width:220px">cross-domain navigation</a>`,
    `document.querySelector('#permission').addEventListener('click',()=>navigator.geolocation.getCurrentPosition(
       ()=>document.querySelector('#permission-result').textContent='permission allowed',
       ()=>document.querySelector('#permission-result').textContent='permission denied',
       {timeout:1000}
     ));
     document.querySelector('#popup').addEventListener('click',()=>open('/popup-destination','buddy-popup'));`,
  );
}

function nativeSurfacePage(): string {
  return html(
    `<button id="dialog" style="left:70px;top:70px;width:220px">open alert</button>
     <input id="file" type="file" style="left:70px;top:170px;width:220px" />
     <button id="audio" style="left:70px;top:270px;width:220px">play audio</button>
     <div id="output" style="left:400px;top:80px">native surfaces idle</div>`,
    `addEventListener('beforeunload',(event)=>{event.preventDefault();event.returnValue='stay'});
     document.querySelector('#dialog').addEventListener('click',()=>{alert('must be suppressed');document.querySelector('#output').textContent='alert continued'});
     document.querySelector('#file').addEventListener('click',()=>setTimeout(()=>document.querySelector('#output').textContent='file chooser intercepted',0));
     document.querySelector('#audio').addEventListener('click',()=>{const context=new AudioContext();const oscillator=context.createOscillator();oscillator.connect(context.destination);oscillator.start();document.querySelector('#output').textContent='audio attempted'});`,
  );
}

function helperBuddyFlowPage(sent: boolean): string {
  return html(
    `<form action="/helper-buddy-submit" method="get">
       <button id="send-update" type="submit" style="left:80px;top:80px;width:220px">Send update</button>
     </form>
     <div id="output" style="left:80px;top:150px">${sent ? 'composed action executed' : 'action idle'}</div>`,
  );
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

async function startFixtures(): Promise<FixtureServers> {
  const cross = await startServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/cross-frame') res.end(framePage('cross-origin target'));
    else if (req.url === '/cross-landing') {
      res.end(html('<h1 style="left:70px;top:70px">cross-domain landing</h1>'));
    } else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
  const main = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/download') {
      res.setHeader('content-disposition', 'attachment; filename="blocked.txt"');
      res.setHeader('content-type', 'text/plain');
      res.end('this download must never reach disk');
      return;
    }
    if (url.pathname === '/redirect-cross') {
      res.statusCode = 302;
      res.setHeader('location', `${cross.origin}/cross-landing`);
      res.end();
      return;
    }
    if (url.pathname === '/helper-buddy-submit') {
      res.statusCode = 302;
      res.setHeader(
        'set-cookie',
        `helper_buddy_action=${encodeURIComponent(runToken)}; Path=/; SameSite=Lax`,
      );
      res.setHeader('location', '/helper-buddy-flow?sent=1');
      res.end();
      return;
    }
    if (url.pathname === '/enroll') {
      const token = url.searchParams.get('token') ?? '';
      res.setHeader(
        'set-cookie',
        `buddy_enrollment=${encodeURIComponent(token)}; Path=/; SameSite=Lax`,
      );
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html('<h1 style="left:70px;top:70px">enrollment ready</h1>'));
      return;
    }
    if (url.pathname === '/cookie-status') {
      const enrolled = (req.headers.cookie ?? '').includes(
        `buddy_enrollment=${encodeURIComponent(runToken)}`,
      );
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        html(`<h1 style="left:70px;top:70px">profile ${enrolled ? 'persisted' : 'missing'}</h1>`),
      );
      return;
    }
    if (url.pathname === '/helper-buddy-flow-status') {
      const executed = (req.headers.cookie ?? '').includes(
        `helper_buddy_action=${encodeURIComponent(runToken)}`,
      );
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        html(
          `<h1 style="left:70px;top:70px">composed action ${executed ? 'persisted' : 'missing'}</h1>`,
        ),
      );
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/controls') res.end(controlsPage());
    else if (url.pathname === '/helper-buddy-flow')
      res.end(helperBuddyFlowPage(url.searchParams.has('sent')));
    else if (url.pathname === '/frames') res.end(framesPage(cross.origin));
    else if (url.pathname === '/same-frame') res.end(framePage('same-origin target'));
    else if (url.pathname === '/security') res.end(securityPage(cross.origin));
    else if (url.pathname === '/native-surfaces') res.end(nativeSurfacePage());
    else if (url.pathname === '/popup-destination') {
      res.end(html('<h1 style="left:70px;top:70px">popup redirected in place</h1>'));
    } else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
  return {
    mainOrigin: main.origin,
    crossOrigin: cross.origin,
    close: async () => {
      await Promise.all([main.close(), cross.close()]);
    },
  };
}

function point(capture: CaptureResult, css: PagePoint): DriverPoint {
  const { meta } = capture;
  return {
    screenIndex: meta.screenIndex,
    x: Math.round((css.x / meta.displayBounds.width) * meta.imageW),
    y: Math.round((css.y / meta.displayBounds.height) * meta.imageH),
  };
}

async function observe(driver: OffscreenBrowserDriver): Promise<CaptureResult> {
  const captures = await driver.capture();
  if (captures.length !== 1)
    throw new Error(`expected one browser capture, received ${captures.length}`);
  const capture = captures[0];
  if (!capture) throw new Error('browser capture was missing');
  if (capture.meta.imageW <= 0 || capture.meta.imageH <= 0 || !capture.jpegBase64) {
    throw new Error('browser capture was empty');
  }
  return capture;
}

async function expectText(
  driver: OffscreenBrowserDriver,
  capture: CaptureResult,
  css: PagePoint,
  expected: string,
): Promise<void> {
  const facts = await driver.inspect(point(capture, css));
  if (!facts?.text.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(
      `expected DOM text ${JSON.stringify(expected)}, received ${JSON.stringify(facts)}`,
    );
  }
}

async function waitForFacts(
  driver: OffscreenBrowserDriver,
  capture: CaptureResult,
  css: PagePoint,
  expected: string,
  timeoutMs = 3_000,
): Promise<ElementFacts> {
  const deadline = Date.now() + timeoutMs;
  let lastFacts: ElementFacts | null = null;
  while (Date.now() < deadline) {
    lastFacts = await driver.inspect(point(capture, css));
    if (lastFacts?.text.toLowerCase().includes(expected.toLowerCase())) return lastFacts;
    await delay(40);
  }
  throw new Error(
    `timed out inspecting ${JSON.stringify(expected)}; last facts: ${JSON.stringify(lastFacts)}`,
  );
}

async function waitForText(
  driver: OffscreenBrowserDriver,
  css: PagePoint,
  expected: string,
  timeoutMs = 2_000,
): Promise<CaptureResult> {
  const deadline = Date.now() + timeoutMs;
  let lastFacts: unknown = null;
  while (Date.now() < deadline) {
    const capture = await observe(driver);
    const facts = await driver.inspect(point(capture, css));
    lastFacts = facts;
    if (facts?.text.toLowerCase().includes(expected.toLowerCase())) return capture;
    await delay(40);
  }
  throw new Error(
    `timed out waiting for ${JSON.stringify(expected)}; last facts: ${JSON.stringify(lastFacts)}`,
  );
}

function expectPaintedBackground(capture: CaptureResult, css: PagePoint): void {
  const image = nativeImage.createFromBuffer(Buffer.from(capture.jpegBase64, 'base64'));
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const target = point(capture, css);
  const x = Math.min(size.width - 1, Math.max(0, target.x));
  const y = Math.min(size.height - 1, Math.max(0, target.y));
  const offset = (y * size.width + x) * 4;
  const blue = bitmap[offset] ?? 255;
  const green = bitmap[offset + 1] ?? 255;
  const red = bitmap[offset + 2] ?? 0;
  if (red < 140 || green > 110 || blue > 130) {
    throw new Error(`hidden capture was not painted: sampled BGRA ${blue},${green},${red}`);
  }
}

async function check(name: string, action: () => Promise<void>): Promise<void> {
  console.log(`BROWSER_E2E START ${name}`);
  const timeout = setTimeout(() => {
    console.error(`BROWSER_E2E FAIL timed out: ${name}`);
    app.exit(1);
  }, 15_000);
  try {
    await action();
  } finally {
    clearTimeout(timeout);
  }
  console.log(`BROWSER_E2E PASS ${name}`);
}

async function expectNavigationRejected(profile: BuddyBrowserProfile, url: string): Promise<void> {
  try {
    await profile.validateDestination(url);
  } catch {
    return;
  }
  throw new Error(`navigation was unexpectedly allowed: ${url}`);
}

function backendResult(
  call: { callId: string; name: string; args: Record<string, unknown> } | null,
  text = '',
): HelperBuddyBackendResult {
  return {
    ok: true,
    outputItems:
      call === null
        ? []
        : [
            {
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          ],
    text,
    functionCalls:
      call === null
        ? []
        : [
            {
              callId: call.callId,
              name: call.name,
              argsJson: JSON.stringify(call.args),
            },
          ],
    searchQueries: [],
    citations: [],
    usedPercent: null,
  };
}

async function runComposedHelperBuddyFlow(
  profile: BuddyBrowserProfile,
  origin: string,
): Promise<OffscreenBrowserDriver> {
  let lastCapture: CaptureResult | null = null;
  let captureCount = 0;
  let round = 0;
  const approvalKinds: string[] = [];
  const resolvedApprovals = new Set<string>();
  const approvalResolutions: Promise<void>[] = [];
  const updateStatuses: string[] = [];
  const reviewed: ActionReviewEvidence[] = [];
  const journal: Array<{ actionKind: string; disposition: string }> = [];
  let executedOutcomes = 0;
  let approvalError: Error | null = null;
  let coordinator!: HelperBuddyApprovalCoordinator;
  coordinator = new HelperBuddyApprovalCoordinator({
    onChanged: (requests) => {
      for (const request of requests) {
        if (resolvedApprovals.has(request.approvalId)) continue;
        resolvedApprovals.add(request.approvalId);
        approvalKinds.push(request.kind);
        console.log(`BROWSER_E2E COMPOSED approval ${request.kind}`);
        const duplicateKind = approvalKinds.filter((kind) => kind === request.kind).length > 1;
        if (duplicateKind) {
          approvalError = new Error(
            `composed flow replaced ${request.kind} approval instead of resolving stable evidence`,
          );
        }
        queueMicrotask(() => {
          const resolution = coordinator
            .resolve(request.approvalId, duplicateKind ? 'deny' : 'once')
            .catch((error: unknown) => {
              approvalError =
                error instanceof Error
                  ? error
                  : new Error(`could not resolve ${request.kind} approval: ${String(error)}`);
            });
          approvalResolutions.push(resolution);
        });
      }
    },
  });
  const grants = new ApprovalGrantStore({
    persistence: { load: () => null, save: () => undefined },
  });
  const gate = new ActionGate<void>({
    reviewer: {
      review: async (evidence) => {
        reviewed.push(evidence);
        console.log(`BROWSER_E2E COMPOSED reviewer ${evidence.actionName}`);
        const consequential = evidence.actionName === 'click';
        return {
          verdict: consequential
            ? {
                verdict: 'escalate' as const,
                reason: 'the requested send is aligned but consequential',
                concern: 'this submits the requested update',
              }
            : { verdict: 'approve' as const, reason: 'the navigation matches the request' },
          evidenceDigest: (consequential ? 'b' : 'a').repeat(64),
          payloadDigest: (evidence.payloadFields ?? []).map(
            (field) => `${field.name}: ${field.value}`,
          ),
          markedScreenshotPng: Buffer.from('mock marked browser evidence').toString('base64'),
        };
      },
    },
    journal: {
      recordActionGateAssessment: (entry) => {
        journal.push({ actionKind: entry.actionKind, disposition: entry.disposition });
      },
      recordComputerActionOutcome: (entry) => {
        if (entry.type === 'computer_action_executed') executedOutcomes += 1;
      },
    },
    grantStore: grants,
    followThrough: new ApprovalFollowThroughTracker(),
  });

  const backend: HelperBuddyBackend = {
    isReady: () => true,
    request: async (request) => {
      round += 1;
      console.log(`BROWSER_E2E COMPOSED backend round ${round}`);
      if (round === 1) {
        return backendResult({
          callId: 'navigate-helper-buddy-flow',
          name: 'browser_navigate',
          args: {
            url: `${origin}/helper-buddy-flow`,
            justification: 'Open the enrolled page where the user asked me to send the update.',
          },
        });
      }
      if (round === 2) {
        return backendResult({
          callId: 'observe-helper-buddy-flow',
          name: 'browser_screenshot',
          args: {
            justification: 'Inspect the enrolled page before acting on the requested update.',
          },
        });
      }
      if (round === 3) {
        if (!lastCapture) {
          throw new Error(
            `helper buddy did not receive a fresh post-navigation capture: ${JSON.stringify(request.input)}`,
          );
        }
        const target = point(lastCapture, { x: 180, y: 100 });
        return backendResult({
          callId: 'send-helper-buddy-update',
          name: 'browser_click',
          args: {
            x: target.x,
            y: target.y,
            label: 'Send update',
            justification: 'Submit the update the user explicitly asked me to send.',
          },
        });
      }
      return backendResult(null, 'the requested update was sent');
    },
  };

  const runner = new HelperBuddyRunner({
    brief: {
      id: 'electron-composed-helper-buddy',
      userRequest: 'Send the update on the enrolled local test site.',
      task: 'Send the requested update with the buddy browser.',
      filesystem: { taskId: 'electron-composed-filesystem', rootName: 'e2e-fixture' },
      recentTranscript: '',
      createdAt: Date.now(),
    },
    backend,
    memory: await initializedMemoryStore(),
    filesystem: unusedFilesystemPort(),
    browser: {
      createDriver: async () => {
        console.log('BROWSER_E2E COMPOSED create real driver');
        const raw = new OffscreenBrowserDriver({ profile });
        return new Proxy(raw, {
          get(target, property) {
            if (property === 'capture') {
              return async (): Promise<CaptureResult[]> => {
                const captures = await target.capture();
                captureCount += 1;
                lastCapture = captures[0] ?? null;
                return captures;
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      gate,
      approvals: coordinator,
      settleMs: 250,
    },
    onUpdate: (summary) => updateStatuses.push(summary.status),
  });

  const summary = await runner.run();
  await Promise.all(approvalResolutions);
  console.log(`BROWSER_E2E COMPOSED runner ${summary.status}`);
  if (approvalError) throw approvalError;
  if (summary.status !== 'done')
    throw new Error(`composed helper buddy ended as ${summary.status}`);
  if (approvalKinds.join(',') !== 'browser-capability,browser-action') {
    throw new Error(`unexpected approval flow: ${approvalKinds.join(',')}`);
  }
  if (updateStatuses.filter((status) => status === 'waiting_approval').length < 2) {
    throw new Error(
      'helper buddy did not park for both capability and consequential-action approval',
    );
  }
  const clickReview = reviewed.find((evidence) => evidence.actionName === 'click');
  if (!clickReview?.facts?.text.includes('Send update') || !clickReview.facts.inForm) {
    throw new Error(
      `consequential click was not DOM grounded: ${JSON.stringify(clickReview?.facts)}`,
    );
  }
  if (!reviewed.some((evidence) => evidence.actionName === 'navigate')) {
    throw new Error('explicit navigation did not pass through the independent reviewer');
  }
  if (
    !journal.some(
      (entry) => entry.actionKind === 'navigate' && entry.disposition === 'dispatch-pending',
    ) ||
    !journal.some((entry) => entry.actionKind === 'click' && entry.disposition === 'await-human') ||
    !journal.some(
      (entry) => entry.actionKind === 'click' && entry.disposition === 'dispatch-pending',
    )
  ) {
    throw new Error(
      `gate journal did not prove approval then execution: ${JSON.stringify(journal)}`,
    );
  }
  if (captureCount < 5 || !lastCapture) {
    throw new Error(`helper buddy did not perform required fresh observations: ${captureCount}`);
  }
  if (executedOutcomes < 2) {
    throw new Error(`gate did not journal both executed actions: ${executedOutcomes}`);
  }

  const verificationDriver = new OffscreenBrowserDriver({ profile });
  await verificationDriver.navigate(`${origin}/helper-buddy-flow-status`);
  const verificationCapture = await observe(verificationDriver);
  await expectText(
    verificationDriver,
    verificationCapture,
    { x: 230, y: 90 },
    'composed action persisted',
  );
  return verificationDriver;
}

function unusedFilesystemPort(): HelperBuddyFilesystemToolPort {
  const unexpected = async (): Promise<never> => {
    throw new Error('the browser E2E fixture must not invoke filesystem tools');
  };
  return {
    runShell: unexpected,
    stagePaths: unexpected,
    runStagedShell: unexpected,
    describeChanges: unexpected,
    presentFile: unexpected,
  };
}

async function initializedMemoryStore(): Promise<HelperBuddyMemoryStore> {
  const store = new HelperBuddyMemoryStore(join(app.getPath('userData'), 'memories'));
  await store.initialize();
  return store;
}

async function run(): Promise<void> {
  const fixtures = await startFixtures();
  const profile = new BuddyBrowserProfile({
    destinationGuard: async (url) => {
      if (![fixtures.mainOrigin, fixtures.crossOrigin].includes(new URL(url).origin)) {
        throw new Error(`fixture did not authorize destination: ${url}`);
      }
    },
  });
  let driver: OffscreenBrowserDriver | null = null;
  try {
    await check(
      'default navigation policy blocks localhost, loopback, and private LAN targets',
      async () => {
        const blockedProfile = new BuddyBrowserProfile({ partition: 'persist:buddy-e2e-blocked' });
        try {
          await expectNavigationRejected(blockedProfile, 'http://localhost/');
          await expectNavigationRejected(blockedProfile, 'http://127.0.0.1/');
          await expectNavigationRejected(blockedProfile, 'http://192.168.1.1/');
        } finally {
          await blockedProfile.dispose();
        }
      },
    );

    await check('visible enrollment provisions the persistent buddy profile', async () => {
      console.log('BROWSER_E2E STEP open enrollment window');
      const enrollment = await profile.createEnrollmentWindow(
        `${fixtures.mainOrigin}/enroll?token=${encodeURIComponent(runToken)}`,
      );
      console.log('BROWSER_E2E STEP verify enrollment state');
      if (!enrollment.isVisible()) throw new Error('enrollment window was not visible');
      console.log('BROWSER_E2E STEP list enrolled sites');
      const enrolledSites = await profile.listEnrolledSites();
      if (!enrolledSites.includes('127.0.0.1')) {
        throw new Error(`enrollment cookie was not listed: ${JSON.stringify(enrolledSites)}`);
      }
      console.log('BROWSER_E2E STEP close enrollment window');
      if (!enrollment.isClosable()) throw new Error('enrollment window was not closable');
      const closed = new Promise<void>((resolve) => enrollment.once('closed', resolve));
      // The verifier has no native user event loop. Destroying after the closable assertion gives
      // the same renderer/profile teardown boundary without relying on OS window-manager timing.
      enrollment.destroy();
      await closed;
      console.log('BROWSER_E2E STEP enrollment window closed');
    });

    driver = new OffscreenBrowserDriver({ profile });
    await check(
      'hidden capture is painted and the browser never becomes visible or focused',
      async () => {
        console.log('BROWSER_E2E STEP navigate hidden controls');
        await driver?.navigate(`${fixtures.mainOrigin}/controls`);
        console.log('BROWSER_E2E STEP capture hidden controls');
        const capture = await observe(driver!);
        const browserWindows = BrowserWindow.getAllWindows();
        if (browserWindows.length !== 1)
          throw new Error(`expected one hidden window, got ${browserWindows.length}`);
        if (browserWindows[0]?.isVisible() || browserWindows[0]?.isFocused()) {
          throw new Error('offscreen browser became visible or focused');
        }
        expectPaintedBackground(capture, { x: 500, y: 500 });
        await expectText(driver!, capture, { x: 160, y: 100 }, 'click target');
      },
    );

    await check('production approval evidence encodes a visible target marker', async () => {
      const capture = await observe(driver!);
      const target = point(capture, { x: 160, y: 100 });
      const marked = await markEvidenceScreenshot({
        base64: capture.jpegBase64,
        mimeType: 'image/jpeg',
        width: capture.meta.imageW,
        height: capture.meta.imageH,
        target,
      });
      const image = nativeImage.createFromBuffer(Buffer.from(marked.pngBase64, 'base64'));
      if (image.isEmpty()) throw new Error('production approval evidence marker encoded empty PNG');
      const size = image.getSize();
      if (size.width !== capture.meta.imageW || size.height !== capture.meta.imageH) {
        throw new Error(
          `marked evidence dimensions changed from ${capture.meta.imageW}x${capture.meta.imageH} to ${size.width}x${size.height}`,
        );
      }
      const bitmap = image.toBitmap();
      const offset = (target.y * size.width + target.x) * 4;
      const pixel = [...bitmap.subarray(offset, offset + 4)];
      if (pixel.join(',') !== '48,59,255,255') {
        throw new Error(`approval evidence target was not marked: BGRA ${pixel.join(',')}`);
      }
      if (!marked.jpegBase64) throw new Error('production approval evidence JPEG was empty');
    });

    await check(
      'hidden click, CDP Unicode insertText, key chords, Enter, and wheel scrolling',
      async () => {
        let capture = await observe(driver!);
        await driver!.click(point(capture, { x: 160, y: 100 }), 'left', 1);
        capture = await observe(driver!);
        await expectText(driver!, capture, { x: 130, y: 155 }, 'clicked');

        await driver!.click(point(capture, { x: 160, y: 240 }), 'left', 1);
        await driver!.typeText('first value');
        const focused = await driver!.inspectFocused();
        if (focused?.tag !== 'input' || !focused.text.includes('first value')) {
          throw new Error(
            `Unicode typing did not land in the focused input: ${JSON.stringify(focused)}`,
          );
        }
        await driver!.pressKeys([process.platform === 'darwin' ? 'META' : 'CTRL', 'A']);
        await driver!.typeText('unicode Ω buddy');
        await driver!.pressKeys(['ENTER']);
        capture = await waitForText(driver!, { x: 180, y: 155 }, 'submitted: unicode Ω buddy');

        await driver!.scroll(point(capture, { x: 500, y: 500 }), 900);
        await waitForText(driver!, { x: 750, y: 35 }, 'scrolled');
      },
    );

    await check(
      'DOM inspect pierces open shadow DOM and same/cross-origin child frames',
      async () => {
        await driver!.navigate(`${fixtures.mainOrigin}/frames`);
        const capture = await observe(driver!);
        console.log('BROWSER_E2E STEP inspect shadow DOM');
        await expectText(driver!, capture, { x: 150, y: 110 }, 'shadow target');
        console.log('BROWSER_E2E STEP inspect same-origin frame');
        const same = await waitForFacts(driver!, capture, { x: 150, y: 300 }, 'same-origin target');
        console.log('BROWSER_E2E STEP inspect cross-origin frame');
        const cross = await waitForFacts(
          driver!,
          capture,
          { x: 550, y: 300 },
          'cross-origin target',
        );
        if (!same?.text.includes('same-origin target') || same.frame !== 'same-origin') {
          throw new Error(`same-origin frame inspection failed: ${JSON.stringify(same)}`);
        }
        if (
          !cross?.text.includes('cross-origin target') ||
          cross.frame === 'cross-origin-unresolved'
        ) {
          throw new Error(`cross-origin frame inspection failed: ${JSON.stringify(cross)}`);
        }
      },
    );

    await check(
      'permissions, downloads, popups, and unauthorized cross-domain navigation are denied',
      async () => {
        console.log('BROWSER_E2E STEP navigate security fixture');
        await driver!.navigate(`${fixtures.mainOrigin}/security`);
        let capture = await observe(driver!);
        console.log('BROWSER_E2E STEP deny geolocation');
        await driver!.click(point(capture, { x: 180, y: 90 }), 'left', 1);
        capture = await waitForText(driver!, { x: 170, y: 145 }, 'permission denied');

        console.log('BROWSER_E2E STEP cancel download');
        const download = new Promise<DownloadItem>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('download event did not fire')), 2_000);
          profile.session.once('will-download', (_event, item) => {
            clearTimeout(timeout);
            resolve(item);
          });
        });
        await driver!.click(point(capture, { x: 170, y: 240 }), 'left', 1);
        const item = await download;
        await delay(100);
        if (item.getState() !== 'cancelled')
          throw new Error(`download state was ${item.getState()}`);

        console.log('BROWSER_E2E STEP deny popup');
        capture = await observe(driver!);
        await driver!.click(point(capture, { x: 170, y: 340 }), 'left', 1);
        capture = await observe(driver!);
        await expectText(driver!, capture, { x: 520, y: 80 }, 'security surface');
        if (BrowserWindow.getAllWindows().length !== 1)
          throw new Error('popup created another BrowserWindow');

        console.log('BROWSER_E2E STEP block cross-domain page navigation');
        let linkRejected = false;
        try {
          await driver!.click(point(capture, { x: 170, y: 440 }), 'left', 1);
        } catch {
          linkRejected = true;
        }
        if (!linkRejected) throw new Error('cross-domain link navigation was not rejected');
        capture = await observe(driver!);
        await expectText(driver!, capture, { x: 520, y: 80 }, 'security surface');

        console.log('BROWSER_E2E STEP block cross-domain redirect');
        let redirectRejected = false;
        try {
          await driver!.navigate(`${fixtures.mainOrigin}/redirect-cross`);
        } catch {
          redirectRejected = true;
        }
        if (!redirectRejected) throw new Error('cross-domain redirect was not rejected');
      },
    );

    await check(
      'hidden pages cannot surface dialogs, file choosers, unload prompts, or audio',
      async () => {
        await driver!.navigate(`${fixtures.mainOrigin}/native-surfaces`);
        let capture = await observe(driver!);

        await driver!.click(point(capture, { x: 180, y: 90 }), 'left', 1);
        capture = await waitForText(driver!, { x: 500, y: 90 }, 'alert continued');

        await driver!.click(point(capture, { x: 180, y: 190 }), 'left', 1);
        capture = await waitForText(driver!, { x: 500, y: 90 }, 'file chooser intercepted');
        const hiddenWindow = BrowserWindow.getAllWindows()[0];
        if (!hiddenWindow || hiddenWindow.isVisible() || hiddenWindow.isFocused()) {
          throw new Error('native-surface attempt made the hidden browser visible or focused');
        }

        await driver!.click(point(capture, { x: 180, y: 290 }), 'left', 1);
        capture = await waitForText(driver!, { x: 500, y: 90 }, 'audio attempted');
        if (!hiddenWindow.webContents.isAudioMuted()) {
          throw new Error('hidden browser audio was not muted');
        }

        // The fixture registered a hostile beforeunload handler. A successful navigation proves
        // it cannot surface a prompt or hold the browser lifecycle hostage.
        await driver!.navigate(`${fixtures.mainOrigin}/controls`);
        capture = await observe(driver!);
        await expectText(driver!, capture, { x: 160, y: 100 }, 'click target');
      },
    );

    await check('persistent profile survives hidden-driver recreation', async () => {
      console.log('BROWSER_E2E STEP dispose first hidden driver');
      await driver!.dispose();
      driver = null;
      console.log('BROWSER_E2E STEP create replacement hidden driver');
      driver = new OffscreenBrowserDriver({ profile });
      console.log('BROWSER_E2E STEP navigate replacement with enrolled cookie');
      await driver.navigate(`${fixtures.mainOrigin}/cookie-status`);
      console.log('BROWSER_E2E STEP inspect replacement profile state');
      const capture = await observe(driver);
      await expectText(driver, capture, { x: 220, y: 90 }, 'profile persisted');
    });

    await check(
      'HelperBuddyRunner composes capability approval, gate review, human approval, real click, and fresh capture',
      async () => {
        await driver!.dispose();
        driver = null;
        driver = await runComposedHelperBuddyFlow(profile, fixtures.mainOrigin);
      },
    );

    await check('driver disposal destroys its window and rejects further work', async () => {
      const owned = driver;
      if (!owned) throw new Error('driver was not created');
      await owned.dispose();
      driver = null;
      if (BrowserWindow.getAllWindows().length !== 0)
        throw new Error('browser window survived disposal');
      let rejected = false;
      try {
        await owned.capture();
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('disposed driver accepted a capture');
    });
  } finally {
    await driver?.dispose();
    await profile.dispose();
    await fixtures.close();
  }
}

app.whenReady().then(async () => {
  try {
    await run();
    writeFileSync(sentinel, 'complete\n', { encoding: 'utf8', mode: 0o600 });
    console.log('BROWSER_E2E COMPLETE');
    app.exit(0);
  } catch (error) {
    console.error('BROWSER_E2E FAIL', error);
    app.exit(1);
  }
});
