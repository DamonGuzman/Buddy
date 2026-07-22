import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(TOOL_DIRECTORY, '../../src/main/agents/helper-buddy-prompt.md');
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = MAX_PROMPT_BYTES + 4 * 1024;
const sessionToken = randomBytes(32).toString('base64url');
const openBrowser = process.env['BUDDY_PROMPT_EDITOR_NO_OPEN'] !== '1';

let writeQueue = Promise.resolve();

function normalizePrompt(source) {
  if (typeof source !== 'string') throw new Error('prompt must be a string');
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!normalized) throw new Error('prompt cannot be empty');
  if (normalized.includes('\0')) throw new Error('prompt cannot contain a null byte');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`prompt cannot exceed ${MAX_PROMPT_BYTES} bytes`);
  }
  return `${normalized}\n`;
}

function revisionFor(source) {
  return createHash('sha256').update(source).digest('base64url');
}

async function loadPrompt() {
  const source = await readFile(PROMPT_PATH, 'utf8');
  return { markdown: normalizePrompt(source).trimEnd(), revision: revisionFor(source) };
}

async function atomicSave(markdown, expectedRevision) {
  const current = await readFile(PROMPT_PATH, 'utf8');
  if (revisionFor(current) !== expectedRevision) {
    const error = new Error('the prompt changed on disk; reload before saving');
    error.statusCode = 409;
    throw error;
  }

  const next = normalizePrompt(markdown);
  const temporaryPath = `${PROMPT_PATH}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o644);
    await handle.writeFile(next, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, PROMPT_PATH);

    if (process.platform !== 'win32') {
      const directoryHandle = await open(dirname(PROMPT_PATH), 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { markdown: next.trimEnd(), revision: revisionFor(next) };
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_REQUEST_BYTES) {
      rejectBody(Object.assign(new Error('request is too large'), { statusCode: 413 }));
      request.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        rejected = true;
        chunks.length = 0;
        rejectBody(Object.assign(new Error('request is too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(
          Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 }),
        );
      }
    });
    request.on('error', rejectBody);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function promptApiPlugin() {
  return {
    name: 'buddy-helper-prompt-api',
    configureServer(server) {
      server.middlewares.use('/api/prompt', async (request, response) => {
        if (request.headers['x-buddy-prompt-token'] !== sessionToken) {
          sendJson(response, 403, { error: 'invalid editor session' });
          return;
        }

        try {
          if (request.method === 'GET') {
            sendJson(response, 200, await loadPrompt());
            return;
          }
          if (request.method !== 'PUT') {
            response.setHeader('allow', 'GET, PUT');
            sendJson(response, 405, { error: 'method not allowed' });
            return;
          }

          const body = await readJsonBody(request);
          if (
            typeof body !== 'object' ||
            body === null ||
            typeof body.markdown !== 'string' ||
            typeof body.revision !== 'string'
          ) {
            sendJson(response, 400, { error: 'markdown and revision are required' });
            return;
          }

          const save = writeQueue.then(() => atomicSave(body.markdown, body.revision));
          writeQueue = save.then(
            () => undefined,
            () => undefined,
          );
          sendJson(response, 200, await save);
        } catch (error) {
          const statusCode =
            typeof error?.statusCode === 'number' && error.statusCode >= 400
              ? error.statusCode
              : 500;
          const message = error instanceof Error ? error.message : 'prompt editor failed';
          sendJson(response, statusCode, { error: message });
        }
      });
    },
  };
}

// Fail before opening a browser if the prompt source is missing or invalid.
await loadPrompt();

const editorServer = await createServer({
  configFile: false,
  root: TOOL_DIRECTORY,
  plugins: [promptApiPlugin()],
  server: {
    host: '127.0.0.1',
    open: openBrowser ? `/?token=${encodeURIComponent(sessionToken)}` : false,
    port: 4179,
    strictPort: false,
  },
});

await editorServer.listen();
editorServer.printUrls();
console.log(`editing ${PROMPT_PATH}`);
const address = editorServer.httpServer?.address();
if (address && typeof address !== 'string') {
  console.log(`editor URL: http://127.0.0.1:${address.port}/?token=${sessionToken}`);
}

async function shutdown() {
  await editorServer.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
