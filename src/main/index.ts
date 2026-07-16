/**
 * App bootstrap — WIRING ONLY. All behavior lives in the owned modules
 * (docs/ARCHITECTURE.md §5); this file just constructs them and connects
 * events to actions, in named composition-root phases. Every CLICKY_* env
 * flag is read through the typed accessors in env.ts.
 *
 * Env flags handled here (must run before app ready):
 * - CLICKY_USER_DATA=<dir>   separate userData dir (parallel dev/QA instances).
 * - CLICKY_FAKE_MIC=<path.wav>  (M8.5 eval harness) route getUserMedia to
 *   Chromium's fake capture device playing this file instead of a real mic.
 *   The file MUST be a 16-bit PCM WAV (mono 24kHz preferred — matches the
 *   session's audio format so no resampling artifacts). Chromium LOOPS the
 *   file continuously; the push-to-talk hold window defines what is actually
 *   sent, so keep utterances ~2-3s and holds ~3.5s. Also auto-grants the mic
 *   permission prompt (use-fake-ui-for-media-stream).
 */

import { app, dialog, Notification, powerMonitor, shell } from 'electron';
import type { Tray } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCodexAuthProvider } from './auth/codex-auth';
import { CodexOAuthLoopback } from './auth/oauth-loopback';
import { CodexAgentBackend } from './agents/backend';
import { ComputerUseRuntime } from './agents/computer-use-runtime';
import { AgentManager } from './agents/manager';
import { MockActionReviewer, MockAgentBackend } from './agents/mock-backend';
import type { AgentBackend, AgentBrief } from './agents/types';
import { assertPublicBrowserDestination, BuddyBrowserProfile } from './computer/browser-profile';
import { runCaptureSelfTest } from './capture-self-test';
import { Conversation } from './conversation';
import { startDebugServer } from './debug-server';
import {
  devChipFlags,
  fakeMicWavPath,
  isAgentMockEnabled,
  isCaptureSelfTestEnabled,
  isPanelCaptureTestEnabled,
  keepPanelOpen,
  phoneAudioAutostart,
  phoneAudioUrl,
  setClickyFlagNames,
  shouldImportApiKeyFromEnv,
  showPanelOnLaunch,
  testMicLabelSubstring,
  testThrowKind,
  userDataDirOverride,
} from './env';
import { describeKind } from './errors';
import { HotkeyManager } from './hotkey';
import { handle, onRendererEvent } from './ipc';
import { SettingsStore } from './settings';
import { SessionRecorder } from './session-recorder';
import {
  TRAY_HINT_CRASHED,
  TRAY_HINT_HOTKEY_DEAD,
  createTray,
  setTrayHint,
  trayHintForMode,
} from './tray';
import { OverlayManager } from './windows/overlay';
import { PanelManager } from './windows/panel';
import { WhisperManager } from './windows/whisper';
import { PermissionController } from './windows/permission-controller';
import { PhoneAudioBridgeClient } from './phone-audio-bridge';
import { PhoneAudioBridgeSupervisor } from './phone-audio-bridge-supervisor';
import { resolvePhoneAudioConfiguration } from './phone-audio-config';
import { NativeReceiverLiveDesktopEvidence } from './computer/live-desktop-evidence';
import { FilesystemTaskService } from './filesystem/service';
import type { MainToPanelChannel, MainToPanelEvents } from '../shared/ipc';
import type {
  AssistantState,
  AudioDeviceError,
  DebugState,
  RuntimeFlags,
  SessionStatus,
  TranscriptEntry,
} from '../shared/types';

// CLICKY_USER_DATA=<dir>: separate userData dir (settings + the
// single-instance lock) so parallel dev/QA instances don't fight over the
// lock. MUST run before requestSingleInstanceLock below.
const userDataOverride = userDataDirOverride();
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
} else {
  // Preserve settings and sign-in state for users upgrading from the legacy
  // heyclicky package name. Fresh installs use Electron's new Buddy path.
  const legacyUserData = join(app.getPath('appData'), 'heyclicky');
  const currentSettings = join(app.getPath('userData'), 'settings.json');
  const legacySettings = join(legacyUserData, 'settings.json');
  if (!existsSync(currentSettings) && existsSync(legacySettings)) {
    app.setPath('userData', legacyUserData);
  }
}

// M8.5 (orchestrator-approved): fake-mic audio injection for the audio eval
// harness — real getUserMedia path, fake device fed from a WAV file. See the
// file header for the contract. MUST run before app ready.
const fakeMicWav = fakeMicWavPath();
if (fakeMicWav) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMicWav);
}

if (process.platform === 'darwin') app.setActivationPolicy('accessory');

// Single instance: a second launch just pops the panel of the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

// ===========================================================================
// Composition root
// ===========================================================================

/** Everything main() constructs, threaded explicitly through the phases. */
interface Services {
  settings: SettingsStore;
  sessionRecorder: SessionRecorder | null;
  overlays: OverlayManager;
  panel: PanelManager;
  whisper: WhisperManager;
  hotkey: HotkeyManager;
  permissions: PermissionController;
  computerUseRuntime: ComputerUseRuntime;
  filesystem: FilesystemTaskService;
  agents: AgentManager;
  conversation: Conversation;
  phoneAudio: PhoneAudioBridgeClient | null;
  phoneBridgeSupervisor: PhoneAudioBridgeSupervisor | null;
}

/** The tray only exists after app ready; earlier phases hold this ref. */
interface TrayRef {
  current: Tray | null;
}

async function main(): Promise<void> {
  // The dev launcher imports OPENAI_API_KEY through Electron safeStorage.
  // Windows DPAPI is only reliable after Electron has reached app.ready.
  if (shouldImportApiKeyFromEnv()) await app.whenReady();

  const tray: TrayRef = { current: null };
  const services = createServices(tray);

  installLastResortHandlers(services, tray);

  const runtime = createRuntimeReporter(services);
  const codexSignin = wireCodexSignin(services);

  registerInvokeHandlers(services, codexSignin.oauth, runtime);
  registerRendererEvents(services);
  wireSettingsBroadcast(services, tray);
  wireHotkey(services);

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  await app.whenReady();
  await services.filesystem.initialize().catch((error: unknown) => {
    console.error('[filesystem] recovery initialization failed', error);
  });
  if (process.platform === 'win32') app.setAppUserModelId('ai.fastyr.buddy');
  if (process.platform === 'darwin') app.dock?.hide();

  services.overlays.start();

  // M11 CRASH FIX: the tray AND the hotkey 'error' listener must exist
  // BEFORE hotkey.start(). A failing keyboard hook emits 'error', and an
  // EventEmitter 'error' with no listener THROWS — which used to escape here
  // and abort the rest of boot (tray, powerMonitor, debug server never ran):
  // a hook failure left the app running with no UI entry point at all.
  tray.current = createTray({
    // M21: the tray click summons the whisper; settings is a menu item.
    onToggleWhisper: () => services.whisper.toggle(),
    onOpenSettings: (anchor) => services.panel.show(anchor),
    onOpenPermissions: (anchor) => {
      services.panel.show(anchor);
      services.panel.send('panel:permissions', services.permissions.current());
    },
    onQuit: () => app.quit(),
  });
  if (services.settings.get().fullRealtimeMode) {
    setTrayHint(tray.current, trayHintForMode(true));
  }

  services.hotkey.on('error', (error) => services.permissions.noteHotkeyError(error));
  services.permissions.refresh(true);

  wirePanelLifecycle(services, tray, runtime, codexSignin.push);
  const codexPoll = startCodexSigninPolling(codexSignin.push);
  const permissionPoll = setInterval(() => {
    if (process.platform === 'darwin') services.permissions.refresh();
  }, 3_000);
  permissionPoll.unref?.();
  wirePowerMonitor(services);

  // M21: a second launch summons the whisper (the panel is settings-only now).
  app.on('second-instance', () => services.whisper.show());
  app.on('activate', () => {
    services.panel.show();
    services.permissions.refresh();
  });
  app.on('browser-window-focus', () => services.permissions.refresh());

  scheduleTestThrow();
  buildDebugSurface(services);
  registerShutdown(services, codexSignin.oauth, codexPoll, permissionPoll);

  // --- M3 capture self-test (CLICKY_CAPTURE_TEST=1) ---
  if (isCaptureSelfTestEnabled()) await runCaptureSelfTest();
}

// ===========================================================================
// Phase: service construction (order is load-bearing — see inline notes)
// ===========================================================================

function createServices(tray: TrayRef): Services {
  // SettingsStore FIRST: overlays (buddy rest / hover config) and the session
  // recorder both read it, and it must exist before overlays.start() runs.
  const settings = new SettingsStore();
  settings.importApiKeyFromEnvironment();

  let sessionRecorder: SessionRecorder | null = null;
  try {
    sessionRecorder = new SessionRecorder({
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      settings: settings.get(),
      // Manifest devFlags: FULL CLICKY_* flag names (CLICKY_DEBUG included),
      // sorted. Deliberately DIFFERENT from the panel's runtime devFlags
      // (devChipFlags below: CLICKY_DEBUG excluded, prefix stripped,
      // lowercased) — the journal wants the exact env inventory, the panel
      // chip wants a compact display list.
      devFlags: setClickyFlagNames(),
    });
    console.log(`[session-recorder] storing this run in ${sessionRecorder.directoryPath}`);
  } catch (err) {
    console.error(
      '[session-recorder] could not initialize persistence:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const overlays = new OverlayManager(settings);
  const panel = new PanelManager({
    showOnLaunch: showPanelOnLaunch(),
    keepOpenOnBlur: keepPanelOpen(),
    captureTest: isPanelCaptureTestEnabled()
      ? { micLabelSubstring: testMicLabelSubstring() }
      : null,
  });
  panel.start(); // pre-create the hidden window at app-ready (M5 mic capture)
  // M20: the whisper composer, anchored beside the buddy's rest spot.
  const whisper = new WhisperManager({ getAnchor: () => overlays.restAnchor() });
  whisper.start(); // pre-create hidden so the first summon is instant
  const filesystem = new FilesystemTaskService({
    basePath: join(app.getPath('userData'), 'filesystem'),
    onState: (state) => whisper.send('whisper:filesystem-state', state),
  });
  const hotkey = new HotkeyManager();

  const codexAuth = getCodexAuthProvider();
  const codexAgentBackend = new CodexAgentBackend(codexAuth);
  const agentMock = isAgentMockEnabled();
  const agentBackend: AgentBackend = agentMock ? new MockAgentBackend() : codexAgentBackend;
  let visibleApprovalIds = new Set<string>();
  const computerUseRuntime = new ComputerUseRuntime({
    whenAppReady: () => app.whenReady(),
    userDataPath: () => app.getPath('userData'),
    codexProvider: () => getCodexAuthProvider(),
    onApprovalsChanged: (requests) => {
      panel.send('panel:approvals', requests);
      const added = requests.filter((request) => !visibleApprovalIds.has(request.approvalId));
      visibleApprovalIds = new Set(requests.map((request) => request.approvalId));
      // Foreground live-desktop computer use has no helper sprite to click.
      // Surface its one-use decision immediately so the user's explicit
      // request cannot park invisibly. Keep the first presentation inactive;
      // clicking a decision may focus it, and the runtime hides/restores the
      // target surface before any verdict can wake native input.
      if (added.some((request) => request.kind === 'live-action')) {
        panel.showInactive();
      } else if (added.length > 0) {
        try {
          tray.current?.displayBalloon({
            title: 'Buddy needs your approval',
            content: added[0]?.actionText ?? 'A helper is waiting for your decision.',
          });
        } catch {
          /* the persistent raised-hand helper remains the fallback surface */
        }
      }
    },
    journal: {
      recordActionGateAssessment: (entry) =>
        sessionRecorder?.record('action_gate_assessment', entry),
      recordComputerActionOutcome: (entry) => {
        if (entry.type === 'computer_action_executed') {
          sessionRecorder?.record('computer_action_executed', entry);
        } else {
          sessionRecorder?.record('computer_action_failed', entry);
        }
        sessionRecorder?.flush();
      },
    },
    onError: (error) => console.error('[computer-use]', error),
    onEnrollmentClosed: () => panel.show(),
    onTakeoverWindowHidden: () => panel.show(),
    beforeLiveApprovalResolution: () => panel.prepareForLiveActionDispatch(),
    onLiveApprovalResolutionFailed: () => panel.showInactive(),
    ...(agentMock ? { createReviewer: () => new MockActionReviewer() } : {}),
    ...(agentMock
      ? {
          createProfile: () =>
            new BuddyBrowserProfile({
              destinationGuard: async (url) => {
                if (
                  url.protocol === 'http:' &&
                  url.hostname === '127.0.0.1' &&
                  url.port === '8237'
                ) {
                  return;
                }
                await assertPublicBrowserDestination(url);
              },
            }),
        }
      : {}),
  });

  const phoneAudioConfiguration = resolvePhoneAudioConfiguration({
    explicitUrl: phoneAudioUrl(),
    autostartBundledBridge: phoneAudioAutostart(),
    platform: process.platform,
  });
  const phoneAudio =
    phoneAudioConfiguration.kind === 'panel'
      ? null
      : new PhoneAudioBridgeClient(phoneAudioConfiguration.url);
  const phoneBridgeSupervisor =
    phoneAudioConfiguration.kind === 'bundled'
      ? new PhoneAudioBridgeSupervisor({
          entryPath: app.isPackaged
            ? join(process.resourcesPath, 'phone-audio-bridge', 'start.mjs')
            : join(app.getAppPath(), 'tools', 'phone-audio-bridge', 'start.mjs'),
          executablePath: process.execPath,
          logPath: join(app.getPath('userData'), 'phone-audio-bridge.log'),
          onStatus: (status) => {
            sessionRecorder?.record('phone_audio_bridge_status', status);
            if (status.state === 'unhealthy' || status.state === 'exited') {
              sessionRecorder?.flush();
            }
          },
        })
      : null;

  // The agent manager and the conversation reference each other (finished
  // agents deliver INTO the conversation; the conversation spawns THROUGH
  // the manager), and the manager must be constructed first (ConversationDeps
  // takes it). Late-bind the back-edge through this ref — it is assigned the
  // moment the conversation exists, and agent runs are async, so no manager
  // callback can fire before then.
  const conversationRef: { current: Conversation | null } = { current: null };
  const agents = new AgentManager({
    backend: agentBackend,
    isReady: () => agentMock || codexAgentBackend.isReady(),
    persistencePath: join(app.getPath('userData'), 'agents.json'),
    browser: computerUseRuntime.browser,
    filesystem,
    // M19: the overlays mirror the same renderer-safe list (helper sprites).
    // M21: the panel's agents view is gone — the overlay helper sprites are
    // the agents surface now.
    onAgentsChanged: (list) => {
      sessionRecorder?.record('agents_changed', list);
      overlays.broadcast('overlay:agents', list);
    },
    onFinished: (summary) => {
      void filesystem
        .completeAgent(summary)
        .then((handled) => {
          if (!handled) {
            conversationRef.current?.deliverAgentResult(summary);
            return;
          }
          const state = filesystem.state();
          const body =
            state?.status === 'review'
              ? `${state.changes.length} file change${state.changes.length === 1 ? '' : 's'} ready to review.`
              : (state?.error ?? 'The folder task finished.');
          try {
            if (process.platform === 'darwin' && Notification.isSupported()) {
              const notification = new Notification({ title: 'Buddy folder task', body });
              notification.on('click', () => whisper.show());
              notification.show();
            } else {
              tray.current?.displayBalloon({ title: 'Buddy folder task', content: body });
            }
          } catch {
            /* the helper sprite remains available when notifications are disabled */
          }
        })
        .catch((error: unknown) => console.error('[filesystem] completion failed', error));
    },
    notify: (title, body) => {
      try {
        tray.current?.displayBalloon({ title, content: body });
      } catch {
        /* unavailable on some systems */
      }
    },
  });
  // M20: the whisper mirrors the conversation surfaces the panel receives
  // (transcript upserts + assistant state) — mirrored HERE, at the panel
  // port, so the conversation package stays whisper-unaware.
  const panelPortWithWhisperMirror = {
    send<C extends MainToPanelChannel>(channel: C, payload: MainToPanelEvents[C]): void {
      panel.send(channel, payload);
      if (channel === 'panel:transcript') {
        whisper.send('whisper:transcript', payload as TranscriptEntry);
      } else if (channel === 'panel:assistant-state') {
        whisper.send('whisper:assistant-state', payload as AssistantState);
      } else if (
        channel === 'panel:session-status' &&
        (payload as SessionStatus).state === 'ready'
      ) {
        panel.resolveCurrentActionableError([
          'no_api_key',
          'api_key_rejected',
          'api_key_unreadable',
          'insufficient_quota',
          'model_unavailable',
          'api_access_forbidden',
          'settings_reset',
        ]);
      }
    },
  };
  const conversation = new Conversation({
    settings,
    overlays,
    panel: panelPortWithWhisperMirror,
    codexAuth,
    agents,
    computerUseSecurity: {
      gate: computerUseRuntime.gate,
      approvals: computerUseRuntime.approvals,
      evidence: new NativeReceiverLiveDesktopEvidence(),
    },
    ...(sessionRecorder !== null ? { sessionRecorder } : {}),
    ...(phoneAudio !== null ? { phoneAudio } : {}),
  });
  conversationRef.current = conversation;

  const notifyUser = (title: string, body: string): void => {
    try {
      if (process.platform === 'darwin' && Notification.isSupported()) {
        new Notification({ title, body }).show();
      } else {
        tray.current?.displayBalloon({ title, content: body });
      }
    } catch {
      /* notifications may be disabled */
    }
  };
  const permissions = new PermissionController({
    hotkey,
    onHealth: (health) => panel.send('panel:permissions', health),
    onHookState: () =>
      panel.send('panel:runtime', {
        hookAlive: hotkey.status().hookAlive,
        devFlags: devChipFlags(),
      }),
    onRecovered: () => setTrayHint(tray.current, trayHintForMode(settings.get().fullRealtimeMode)),
    onUnavailable: (error, health) => {
      sessionRecorder?.record('hotkey_start_failed', {
        name: error.name,
        message: error.message,
        permissions: health,
      });
      sessionRecorder?.flush();
      conversation.reportError('hotkey_dead', {
        macHotkeyPermissions: process.platform === 'darwin',
      });
      setTrayHint(
        tray.current,
        process.platform === 'darwin'
          ? 'buddy — permissions need attention, click to fix or type'
          : TRAY_HINT_HOTKEY_DEAD,
      );
      notifyUser(
        'Buddy permissions need attention',
        'Push-to-talk is offline. Open Buddy Settings to repair it; typing still works.',
      );
    },
  });

  phoneAudio?.on('audio', (chunk) => conversation.handleAudioChunk(chunk));
  phoneAudio?.on('connected', () => {
    sessionRecorder?.record('phone_audio_bridge_client', { state: 'connected' });
    sessionRecorder?.flush();
  });
  phoneAudio?.on('disconnected', () => {
    sessionRecorder?.record('phone_audio_bridge_client', { state: 'disconnected' });
  });
  // The bundled supervisor has a synchronous platform guard. Start it before
  // opening the client socket so an unsupported explicit QA configuration
  // fails without leaving a reconnecting transport behind.
  phoneBridgeSupervisor?.start();
  phoneAudio?.start();

  return {
    settings,
    sessionRecorder,
    overlays,
    panel,
    whisper,
    hotkey,
    permissions,
    computerUseRuntime,
    filesystem,
    agents,
    conversation,
    phoneAudio,
    phoneBridgeSupervisor,
  };
}

// ===========================================================================
// Phase: last-resort crash handling
// ===========================================================================

/**
 * M11: an uncaught main-process exception used to pop Electron's raw dialog
 * (or kill the tray app outright). Log it to <userData>/clicky.log, keep the
 * app alive, and let the tray tooltip say what to do. Registered FIRST so
 * even boot-time throws are covered.
 */
function installLastResortHandlers({ sessionRecorder }: Services, tray: TrayRef): void {
  const logFatal = (kind: string, err: unknown): void => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[fatal] ${kind}:`, detail);
    sessionRecorder?.record('fatal_error', { kind, error: err });
    sessionRecorder?.flush();
    try {
      appendFileSync(
        join(app.getPath('userData'), 'clicky.log'),
        `[${new Date().toISOString()}] ${kind}: ${detail}\n`,
      );
    } catch {
      /* the crash logger must never crash */
    }
    try {
      tray.current?.setToolTip(TRAY_HINT_CRASHED);
    } catch {
      /* tray may be gone during shutdown */
    }
  };
  process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));
}

// ===========================================================================
// Phase: runtime flags for the panel
// ===========================================================================

interface RuntimeReporter {
  flags: () => RuntimeFlags;
  push: () => void;
}

/**
 * M11: runtime flags for the panel — hookAlive (the hero hint adapts when
 * the hook is dead) + CLICKY_* dev/QA flags besides CLICKY_DEBUG (generic
 * dev chip in the header, extending the old mock-only badge).
 */
function createRuntimeReporter({ hotkey, panel }: Services): RuntimeReporter {
  const devFlags = devChipFlags();
  const flags = (): RuntimeFlags => ({ hookAlive: hotkey.status().hookAlive, devFlags });
  return { flags, push: () => panel.send('panel:runtime', flags()) };
}

// ===========================================================================
// Phase: Codex ChatGPT-subscription sign-in
// ===========================================================================

interface CodexSigninWiring {
  /** Push the sign-in snapshot to the panel (force = ignore the dedupe). */
  push: (force: boolean) => void;
  oauth: CodexOAuthLoopback;
}

/**
 * M17 (integration): push the Codex ChatGPT-subscription sign-in snapshot to
 * the panel — on ready, and whenever it changes (the CLI's auth.json can
 * rotate out from under us, so a light 60s poll refreshes it). The codex*
 * fields also ride on 'panel:settings'; we re-push that on change so the
 * settings "ChatGPT" card updates without a fresh settings:get().
 */
function wireCodexSignin({ settings, panel, conversation }: Services): CodexSigninWiring {
  let lastCodexSignin = '';
  const push = (force: boolean): void => {
    let state;
    try {
      state = getCodexAuthProvider().codexSignInState();
    } catch (err) {
      console.warn(
        '[boot] codex sign-in state unavailable:',
        err instanceof Error ? err.name : 'unknown',
      );
      return;
    }
    const key = JSON.stringify(state);
    if (!force && key === lastCodexSignin) return;
    lastCodexSignin = key;
    panel.send('panel:codex-signin', state);
    panel.send('panel:settings', settings.get());
    if (state.signedIn && state.valid) {
      panel.resolveCurrentActionableError(['agent_not_signed_in']);
    }
    conversation.onAgentAvailabilityChanged();
  };
  const oauth = new CodexOAuthLoopback({
    auth: getCodexAuthProvider(),
    openExternal: (url) => shell.openExternal(url),
    onComplete: () => push(true),
  });
  return { push, oauth };
}

/**
 * M17 (integration): warm the Codex auth provider at boot so the first
 * grounding call (and the first panel snapshot) doesn't pay the token-store
 * / auth.json read latency, and push the initial snapshot. A light 60s poll
 * catches the CLI's auth.json rotating (sign-in/out/refresh) out from under
 * us and re-pushes to the panel only when it actually changed.
 */
function startCodexSigninPolling(push: (force: boolean) => void): NodeJS.Timeout {
  try {
    getCodexAuthProvider().codexSignInState();
  } catch (err) {
    console.warn('[boot] codex warm failed:', err instanceof Error ? err.name : 'unknown');
  }
  push(true);
  const codexPoll = setInterval(() => push(false), 60_000);
  codexPoll.unref?.();
  return codexPoll;
}

// ===========================================================================
// Phase: typed invoke handlers (single registration point for InvokeChannels)
// ===========================================================================

function registerInvokeHandlers(
  {
    settings,
    conversation,
    agents,
    permissions,
    panel,
    whisper,
    computerUseRuntime,
    filesystem,
  }: Services,
  codexOAuth: CodexOAuthLoopback,
  runtime: RuntimeReporter,
): void {
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => settings.set(patch));
  handle('panel:ask-text', (text) => conversation.askText(text));
  handle('filesystem:select-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for Buddy',
      buttonLabel: 'Work in this folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      message:
        'Buddy will work in a private copy. You review changes before they reach this folder.',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selection = await filesystem.grant(result.filePaths[0]);
    whisper.show();
    return selection;
  });
  handle('filesystem:start', async (grantId, request) => {
    if (typeof grantId !== 'string' || typeof request !== 'string')
      throw new Error('invalid filesystem task');
    const prepared = await filesystem.prepare(grantId, request);
    const agentId = `agent_fs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await filesystem.attachAgent(prepared.taskId, agentId);
    const brief: AgentBrief = {
      id: agentId,
      userRequest: request.trim(),
      task: request.trim(),
      recentTranscript: '',
      createdAt: Date.now(),
      browserEnabled: false,
      filesystem: { taskId: prepared.taskId, rootName: prepared.rootName },
    };
    const spawned = agents.spawn(brief);
    if (!spawned.ok) {
      const reason =
        spawned.reason === 'not_signed_in'
          ? 'Sign in to ChatGPT in Buddy Settings before starting a folder task.'
          : spawned.reason === 'at_capacity'
            ? 'Buddy already has too many helpers running. Stop one and try again.'
            : 'Filesystem execution is unavailable.';
      return filesystem.fail(prepared.taskId, reason);
    }
    whisper.show();
    return filesystem.state() ?? prepared;
  });
  handle('filesystem:get-state', () => filesystem.state());
  handle('filesystem:publish', (taskId) => filesystem.publish(taskId));
  handle('filesystem:discard', (taskId) => filesystem.discard(taskId));
  handle('filesystem:undo', (taskId) => filesystem.undo(taskId));
  handle('filesystem:keep', (taskId) => filesystem.keep(taskId));
  handle('filesystem:cancel', (taskId) => {
    const state = filesystem.state();
    if (!state || state.taskId !== taskId || !state.agentId)
      throw new Error('filesystem task not found');
    agents.cancel(state.agentId);
  });
  // Known limitation: mic devices are enumerated by the panel renderer
  // locally; main has no device list to serve (mic:list returns []).
  handle('mic:list', () => []);
  handle('mic:select', (deviceId) => {
    settings.set({ micDeviceId: deviceId });
  });
  handle('overlay:get-state', () => conversation.assistantState());
  // M11 addition (orchestrator-approved): runtime flags bootstrap.
  handle('panel:get-runtime', () => runtime.flags());
  handle('permissions:get', () => permissions.current());
  handle('permissions:action', (action) => permissions.act(action));
  handle('panel:get-actionable-error', () => panel.actionableErrorState());
  handle('panel:resolve-actionable-error', (expected) => panel.resolveActionableError(expected));
  handle('panel:dismiss-actionable-error', (expected) => panel.dismissActionableError(expected));
  // M17 addition (integration-approved): Codex sign-in snapshot bootstrap.
  handle('codex:signin-state', () => getCodexAuthProvider().codexSignInState());
  handle('codex:sign-in', () => codexOAuth.start());
  handle('agents:list', () => agents.list());
  handle('agents:cancel', async (id) => {
    agents.cancel(id);
    await computerUseRuntime.cancelAgent(id);
  });
  handle('agents:cancel-all', async () => {
    agents.cancelAll();
    await computerUseRuntime.cancelAll();
  });
  handle('agents:mark-seen', (id) => agents.markSeen(id));
  handle('approval:resolve', (agentId, approvalId, verdict) =>
    computerUseRuntime.controller.resolveApproval(agentId, approvalId, verdict),
  );
  handle('approval:show-window', (agentId, approvalId) =>
    computerUseRuntime.controller.showApprovalWindow(agentId, approvalId),
  );
  handle('approval:hide-window', (agentId, approvalId) =>
    computerUseRuntime.controller.hideApprovalWindow(agentId, approvalId),
  );
  handle('approvals:list', () => computerUseRuntime.controller.listApprovals());
  handle('grants:list', () => computerUseRuntime.controller.listGrants());
  handle('grants:revoke', (id) => computerUseRuntime.controller.revokeGrant(id));
  handle('buddy-browser:open-enroll', (url) => computerUseRuntime.controller.openEnrollment(url));
  handle('buddy-browser:list-enrolled-sites', () =>
    computerUseRuntime.controller.listEnrolledSites(),
  );
  handle('buddy-browser:sign-out-site', async (domain) => {
    await agents.withBrowserAdmissionBlocked(() =>
      computerUseRuntime.controller.signOutSite(domain),
    );
  });
  handle('buddy-browser:clear', async () => {
    await agents.withBrowserAdmissionBlocked(() => computerUseRuntime.controller.clearAll());
  });
}

// ===========================================================================
// Phase: fire-and-forget renderer events
// ===========================================================================

/** IPC payloads are untrusted renderer input — validate before acting. */
function validAudioDeviceError(payload: AudioDeviceError): AudioDeviceError | null {
  if (!payload || (payload.source !== 'mic' && payload.source !== 'playback')) return null;
  return {
    source: payload.source,
    name: typeof payload.name === 'string' ? payload.name : 'Error',
    message: typeof payload.message === 'string' ? payload.message : '',
  };
}

/** IPC payloads are untrusted renderer input — validate before acting. */
function validAgentId(payload: { id: string }): string | null {
  return payload && typeof payload.id === 'string' ? payload.id : null;
}

function registerRendererEvents({
  conversation,
  whisper,
  agents,
  panel,
  computerUseRuntime,
  filesystem,
}: Services): void {
  onRendererEvent('audio:chunk', (chunk) => {
    conversation.handleAudioChunk(chunk);
  });
  // M11 addition (orchestrator-approved): audio device failure reports from
  // the panel renderer (mic capture start / playback init).
  onRendererEvent('audio:capture-error', (payload) => {
    const report = validAudioDeviceError(payload);
    if (report) conversation.handleAudioDeviceError(report);
  });
  // M8.5 (orchestrator-approved): playback tap reporting from the panel.
  onRendererEvent('audio:playback-stats', (stats) => {
    conversation.handlePlaybackStats(stats);
  });
  onRendererEvent('audio:playback-ring', (ring) => {
    conversation.handlePlaybackRing(ring);
  });
  // Waiting helpers use their click to bring the approval queue into view.
  onRendererEvent('overlay:agent-click', (payload) => {
    const id = validAgentId(payload);
    if (id === null) return;
    const agent = agents.list().find((item) => item.id === id);
    if (filesystem.state()?.agentId === id) whisper.show();
    else if (agent?.status === 'waiting_approval') panel.show();
  });
  onRendererEvent('overlay:agent-cancel', (payload) => {
    const id = validAgentId(payload);
    if (id !== null) {
      agents.cancel(id);
      void computerUseRuntime
        .cancelAgent(id)
        .catch((error: unknown) =>
          console.error('[computer-use] agent cancellation failed', error),
        );
    }
  });
  // M20: the whisper asked to tuck away (esc / close affordance).
  onRendererEvent('whisper:hide', () => whisper.hide());
}

// ===========================================================================
// Phase: module event wiring
// ===========================================================================

function wireSettingsBroadcast(
  { settings, panel, whisper, conversation }: Services,
  tray: TrayRef,
): void {
  settings.onChange((snapshot) => {
    panel.send('panel:settings', snapshot);
    whisper.send('whisper:settings', snapshot); // M20: quiet-mode toggle state
    conversation.onSettingsChanged(snapshot);
    setTrayHint(tray.current, trayHintForMode(snapshot.fullRealtimeMode));
  });
}

function wireHotkey({ hotkey, settings, conversation, whisper, overlays }: Services): void {
  hotkey.on('hold-start', () => {
    if (settings.get().fullRealtimeMode) void conversation.toggleFullRealtime();
    else conversation.holdStart();
  });
  hotkey.on('hold-end', () => {
    if (!settings.get().fullRealtimeMode) conversation.holdEnd();
  });
  // M20 (the whisper): a TAP — release within TAP_MAX_MS — toggles the text
  // composer in push-to-talk mode. The conversation has already handled the
  // matching hold-end as an accidental-tap cancel (MIN_HOLD_MS shares the
  // boundary), so no voice turn was committed. Full realtime mode ignores
  // taps: there the PRESS toggles the open-mic session (existing behavior),
  // and the whisper stays reachable by clicking the buddy.
  hotkey.on('tap', () => {
    if (!settings.get().fullRealtimeMode) whisper.toggle();
  });
  hotkey.on('primary-click', (ctrlKey) => {
    if (process.platform !== 'darwin' || overlays.isBuddyInteractive()) return;
    if (ctrlKey) overlays.openSettingsIfBuddyClicked();
    else overlays.openWhisperIfBuddyClicked();
  });
  hotkey.on('secondary-click', () => {
    // Before the hover dwell flips the narrow Buddy region interactive, the
    // overlay is intentionally click-through. Hit-test the global click so a
    // normal immediate right-click still opens Settings. Once interactive,
    // the renderer owns the contextmenu event and this fallback stays silent.
    if (!overlays.isBuddyInteractive()) overlays.openSettingsIfBuddyClicked();
  });
  // F1 fix (C1): forced release (max-hold watchdog / lock / suspend) cancels
  // the hold — mic released, held audio cleared, NO turn committed.
  // M11 (hold_too_long): the 30s watchdog cancel additionally TELLS the user
  // (it used to be silent — the answer just never came).
  hotkey.on('hold-cancel', (reason) => {
    if (settings.get().fullRealtimeMode) return;
    conversation.cancelHold();
    if (reason === 'watchdog') conversation.reportError('hold_too_long');
  });
}

function wirePanelLifecycle(
  { panel, whisper, settings, conversation, permissions, computerUseRuntime, filesystem }: Services,
  tray: TrayRef,
  runtime: RuntimeReporter,
  pushCodexSignin: (force: boolean) => void,
): void {
  // M11 (renderer_dead): panel crash recovery gave up — the window has been
  // torn down (a tray click builds a fresh one); tell the user via the tray.
  panel.onFatal(() => {
    const dead = describeKind('renderer_dead');
    try {
      tray.current?.displayBalloon({ title: 'buddy', content: dead.message });
    } catch {
      /* balloons can be unavailable; the tooltip below still lands */
    }
    setTrayHint(tray.current, `buddy — ${dead.message}`);
  });

  // M11: every panel renderer load (boot + crash-recreate) gets the current
  // transcript ring, status snapshots and runtime flags replayed — boot-time
  // errors (hotkey_dead, settings_reset) no longer vanish because they were
  // pushed before the renderer existed.
  panel.onRendererReady(() => {
    conversation.replayToPanel();
    panel.send('panel:settings', settings.get());
    runtime.push();
    panel.send('panel:permissions', permissions.current());
    panel.send('panel:approvals', computerUseRuntime.controller.listApprovals());
    // M17: hand the (re)loaded panel the current Codex sign-in snapshot.
    pushCodexSignin(true);
  });

  // M20: the whisper renderer gets the same replay on (re)load — the replay
  // flows through the mirrored panel port, so a crash-recreated whisper
  // refills its reply stack (the panel tolerates the duplicate upserts:
  // transcript entries are idempotent by id).
  whisper.onRendererReady(() => {
    conversation.replayToPanel();
    whisper.send('whisper:settings', settings.get());
    whisper.send('whisper:filesystem-state', filesystem.state());
  });
}

function wirePowerMonitor({
  sessionRecorder,
  hotkey,
  conversation,
  permissions,
  agents,
  computerUseRuntime,
}: Services): void {
  // F1 fix (C1 + sleep/resume): the secure desktop (Ctrl+Alt+Del) and lock
  // screen swallow keyups — force-cancel any live hold and reset modifier
  // state so the mic can never stay hot on a locked machine. On resume, the
  // realtime socket may be half-open; reset it so the next turn reconnects.
  powerMonitor.on('lock-screen', () => {
    sessionRecorder?.record('system_lock', null);
    hotkey.forceCancel();
    conversation.deactivateFullRealtime();
    void agents
      .cancelBrowserRuns()
      .then(() => computerUseRuntime.suspend())
      .catch((error: unknown) => console.error('[computer-use] lock shutdown failed', error));
  });
  powerMonitor.on('suspend', () => {
    sessionRecorder?.record('system_suspend', null);
    sessionRecorder?.flush();
    hotkey.forceCancel();
    conversation.deactivateFullRealtime();
    void agents
      .cancelBrowserRuns()
      .then(() => computerUseRuntime.suspend())
      .catch((error: unknown) => console.error('[computer-use] suspend shutdown failed', error));
  });
  powerMonitor.on('resume', () => {
    sessionRecorder?.record('system_resume', null);
    computerUseRuntime.resume();
    conversation.onSystemResume();
    permissions.refresh();
  });
}

// ===========================================================================
// Phase: debug + QA surfaces
// ===========================================================================

/**
 * M11: last-resort-handler verification hook (headless QA only):
 * CLICKY_TEST_THROW=exception|rejection blows up 3s after boot so the
 * harness can assert the app SURVIVES and the crash landed in clicky.log.
 */
function scheduleTestThrow(): void {
  const kind = testThrowKind();
  if (!kind) return;
  setTimeout(() => {
    if (kind === 'rejection') {
      void Promise.reject(new Error('debug-injected unhandled rejection'));
    } else {
      throw new Error('debug-injected uncaught exception');
    }
  }, 3_000);
}

function buildDebugSurface({
  conversation,
  overlays,
  panel,
  hotkey,
  agents,
  computerUseRuntime,
}: Services): void {
  const getDebugState = (): DebugState => ({
    appVersion: app.getVersion(),
    assistantState: conversation.assistantState(),
    overlayWindowCount: overlays.count(),
    panelVisible: panel.isVisible(),
    hotkey: hotkey.status(),
    session: conversation.sessionStatus(),
    ...conversation.debugInfo(),
    // M8.5 additions (orchestrator-approved): audio-experience eval.
    lastTurnTimings: conversation.lastTurnTimings(),
    turnTimingsHistory: conversation.turnTimingsHistory(),
  });
  startDebugServer({
    getState: getDebugState,
    pipeline: {
      // EXACT hold-start/hold-end code paths: simulate() runs the same
      // FSM -> 'hold-start'/'hold-end' handlers as real key events.
      pressHotkey: () => hotkey.simulate('press'),
      releaseHotkey: () => hotkey.simulate('release'),
      askText: (text) => conversation.askText(text),
      getTranscript: () => conversation.transcript(),
      playback: (command) => conversation.playback(command),
    },
    // M8.5 (orchestrator-approved): audio eval surface.
    audioEval: {
      getOutputStats: () => conversation.outputStats(),
      getLastOutputRing: () => conversation.lastOutputRing(),
      getTimings: () => ({
        last: conversation.lastTurnTimings(),
        history: conversation.turnTimingsHistory(),
      }),
    },
    // M9: drive the element-snap grounding daemon directly (no model).
    grounding: {
      query: (q) => conversation.debugGroundingQuery(q),
    },
    agents: {
      spawn: (task) =>
        agents.spawn({
          id: `agent_debug_${Date.now()}`,
          userRequest: task,
          task,
          recentTranscript: '',
          createdAt: Date.now(),
          browserEnabled: false,
        }),
      spawnBrowser: (task) =>
        agents.spawn({
          id: `agent_debug_browser_${Date.now()}`,
          userRequest: task,
          task,
          recentTranscript: '',
          createdAt: Date.now(),
          browserEnabled: true,
        }),
      list: () => agents.list(),
      cancel: (id) => {
        agents.cancel(id);
        void computerUseRuntime
          .cancelAgent(id)
          .catch((error: unknown) =>
            console.error('[computer-use] debug cancellation failed', error),
          );
      },
    },
    computerUse: {
      assessGate: async (input) => ({
        ok: false,
        error:
          'standalone assessment has no trusted browser observation; spawn a browser mock scenario to exercise the production gate',
        agentId: input.agentId ?? null,
      }),
      listGrants: () => computerUseRuntime.controller.listGrants(),
      resolveAgentApproval: async (agentId, approvalId, verdict) => {
        const request = computerUseRuntime.controller
          .listApprovals()
          .find((item) => item.approvalId === approvalId);
        if (!request || request.agentId !== agentId) return false;
        await computerUseRuntime.controller.resolveApproval(
          request.agentId,
          request.approvalId,
          verdict,
        );
        return true;
      },
    },
  });
}

// ===========================================================================
// Phase: shutdown
// ===========================================================================

function registerShutdown(
  {
    hotkey,
    conversation,
    phoneAudio,
    phoneBridgeSupervisor,
    agents,
    computerUseRuntime,
    sessionRecorder,
    overlays,
    panel,
    whisper,
  }: Services,
  codexOAuth: CodexOAuthLoopback,
  codexPoll: NodeJS.Timeout,
  permissionPoll: NodeJS.Timeout,
): void {
  // Tray app: stay alive with zero visible windows.
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
  // Electron does not await `will-quit`. Hold the first before-quit so parked
  // approvals, acting runs, browser windows, and profile handlers are gone
  // before the session journal is closed.
  let shutdownStarted = false;
  let shutdownFinished = false;
  app.on('before-quit', (event) => {
    if (shutdownFinished) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      const attempt = async (label: string, run: () => void | Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          console.error(`[shutdown] ${label} failed`, error);
        }
      };
      clearInterval(codexPoll);
      clearInterval(permissionPoll);
      await attempt('codex oauth', () => codexOAuth.stop());
      await attempt('hotkey', () => hotkey.stop());
      await attempt('conversation', () => conversation.close());
      await attempt('phone audio', () => phoneAudio?.close());
      await attempt('phone bridge', () => phoneBridgeSupervisor?.close());
      await attempt('agents', () => agents.dispose());
      await attempt('computer use', () => computerUseRuntime.dispose());
      await attempt('session recorder', () => sessionRecorder?.close('app_quit'));
      await attempt('overlays', () => overlays.destroy());
      await attempt('panel', () => panel.destroy());
      await attempt('whisper', () => whisper.destroy());
      shutdownFinished = true;
      app.quit();
    })();
  });
}
