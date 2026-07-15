import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';

vi.mock('electron', () => ({
  app: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class BrowserWindow {},
  session: { fromPartition: vi.fn() },
}));

import { BuddyBrowserProfile } from '../src/main/computer/browser-profile';

type BeforeRequestCallback = (result: { cancel: boolean }) => void;
type BeforeRequestHandler = (
  details: { webContentsId?: number; resourceType: string; url: string },
  callback: BeforeRequestCallback,
) => void;

let requestHandler: BeforeRequestHandler | null;

beforeEach(() => {
  requestHandler = null;
});

describe('BuddyBrowserProfile proxy readiness', () => {
  it('holds all network requests until the fixed proxy is installed', async () => {
    const proxyInstall = deferred<void>();
    const session = fakeSession(() => proxyInstall.promise);
    const profile = createProfile(session);
    void profile.session;
    await vi.waitFor(() => expect(session.setProxy).toHaveBeenCalledOnce());

    const callback = vi.fn<BeforeRequestCallback>();
    getRequestHandler()(requestDetails(), callback);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    proxyInstall.resolve();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: false }));
    await profile.dispose();
  });

  it('cancels requests and fails readiness when proxy installation rejects', async () => {
    const proxyInstall = deferred<void>();
    const session = fakeSession(() => proxyInstall.promise);
    const logger = { warn: vi.fn() };
    const profile = createProfile(session, logger);
    void profile.session;
    await vi.waitFor(() => expect(session.setProxy).toHaveBeenCalledOnce());

    const callback = vi.fn<BeforeRequestCallback>();
    getRequestHandler()(requestDetails(), callback);
    proxyInstall.reject(new Error('setProxy failed'));

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    await expect(profile.listEnrolledSites()).rejects.toThrow('setProxy failed');
    await expect(profile.dispose()).rejects.toThrow('setProxy failed');
  });

  it('loads the persisted origin ledger only after the Session storage path exists', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'buddy-browser-ledger-'));
    await writeFile(
      join(storagePath, 'buddy-visited-origins.json'),
      `${JSON.stringify(['https://sub.example.com'])}\n`,
      'utf8',
    );
    const session = fakeSession(async () => undefined, storagePath);
    const profile = createProfile(session);
    try {
      await profile.clearEnrolledSite('example.com');
      expect(session.clearStorageData).toHaveBeenCalledWith({
        origin: 'https://sub.example.com',
      });
    } finally {
      await profile.dispose();
      await rm(storagePath, { recursive: true, force: true });
    }
  });
});

function createProfile(session: Session, logger = { warn: vi.fn() }): BuddyBrowserProfile {
  return new BuddyBrowserProfile({
    partition: 'persist:buddy-proxy-readiness-test',
    destinationGuard: async () => undefined,
    sessionFactory: () => session,
    logger,
  });
}

function fakeSession(setProxy: () => Promise<void>, storagePath?: string): Session {
  return {
    storagePath,
    setProxy: vi.fn(setProxy),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    closeAllConnections: vi.fn(async () => undefined),
    cookies: {
      get: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
    },
    clearStorageData: vi.fn(async () => undefined),
    flushStorageData: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn((handler: BeforeRequestHandler | null) => {
        requestHandler = handler;
      }),
    },
  } as unknown as Session;
}

function getRequestHandler(): BeforeRequestHandler {
  if (!requestHandler) throw new Error('onBeforeRequest handler was not installed');
  return requestHandler;
}

function requestDetails(): { resourceType: string; url: string } {
  return { resourceType: 'script', url: 'https://example.test/app.js' };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
