import type {
  HelperBuddyBrowserDeps,
  HelperBuddyFilesystemToolPort,
} from '../../src/main/agents/types';

export const TEST_FILESYSTEM_BRIEF = { taskId: 'test-filesystem-task', rootName: 'test-root' };

export function createTestHelperBuddyFilesystem(): HelperBuddyFilesystemToolPort {
  return {
    runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    stagePaths: async () => JSON.stringify({ ok: true }),
    runStagedShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    describeChanges: async () => JSON.stringify({ changes: [] }),
    viewImage: async (_taskId, path) => ({
      path,
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      bytes: 8,
    }),
    presentFile: async () => JSON.stringify({ ok: true }),
  };
}

export function createTestHelperBuddyBrowser(): HelperBuddyBrowserDeps {
  return {
    createDriver: async () => {
      throw new Error('browser driver was not expected in this test');
    },
    gate: {
      execute: async () => {
        throw new Error('browser gate was not expected in this test');
      },
      resolveEscalation: async () => {
        throw new Error('browser escalation was not expected in this test');
      },
      cancelHelperBuddy: () => undefined,
    },
    approvals: {
      request: async () => {
        throw new Error('browser approval was not expected in this test');
      },
      cancelHelperBuddy: () => undefined,
      get: () => null,
      resolve: async () => undefined,
    },
  };
}

export function createTestHelperBuddyCapabilities(): {
  browser: HelperBuddyBrowserDeps;
  filesystem: HelperBuddyFilesystemToolPort;
} {
  return {
    browser: createTestHelperBuddyBrowser(),
    filesystem: createTestHelperBuddyFilesystem(),
  };
}
