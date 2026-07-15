/**
 * M11 test helper: a hostile Realtime endpoint. Where server.js plays a
 * healthy OpenAI, this one fails in controlled ways so the error catalog can
 * be exercised end-to-end (tests/conversation-errors.test.ts + the headless
 * error-UX verification):
 *
 * - `status: 401|403|404|429|500` — REJECT the WebSocket upgrade with that
 *   HTTP status. The ws client surfaces "Unexpected server response: <n>",
 *   which the classifier maps (401 → api_key_rejected, 403/404 →
 *   model_unavailable, 429 → rate_limited, 5xx → server_error).
 * - `preSettleError: {code, message, type?, closeCode?}` — ACCEPT the
 *   upgrade, send one pre-settle `error` event, then close (the
 *   insufficient_quota rejection shape the live API uses: error + close 1013).
 * - neither — accept the upgrade and go silent (handshake-timeout testing).
 *
 * CLI (for the headless app harness):
 *   node tools/mock-realtime/reject-server.js --port 8125 --status 401
 *   node tools/mock-realtime/reject-server.js --port 8125 \
 *     --error-code insufficient_quota --error-message "You exceeded your current quota..."
 */
// @ts-check
'use strict';

const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');

/**
 * @typedef {object} RejectServerPreSettleError
 * @property {string} code
 * @property {string} message
 * @property {string} [type] defaults to 'invalid_request_error'
 * @property {number} [closeCode] defaults to 1013 (the live quota-rejection close code)
 * @property {string} [closeReason]
 */

/**
 * @typedef {object} RejectServerOptions
 * @property {string} [host]
 * @property {number} [port] 0 (the default) = ephemeral port
 * @property {number} [status] reject the WS upgrade with this HTTP status
 * @property {RejectServerPreSettleError} [preSettleError]
 *   accept the upgrade, send one pre-settle error event, then close
 * @property {(line: string) => void} [log]
 */

/**
 * @typedef {object} RejectServerHandle
 * @property {string} host
 * @property {number} port
 * @property {string} url
 * @property {() => Promise<void>} close
 */

/** @type {Record<number, string>} */
const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * @param {RejectServerOptions} [options]
 * @returns {Promise<RejectServerHandle>}
 */
function createRejectServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 0;
  const log = options.log || (() => {});

  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('upgrade required');
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket) => {
      if (options.status) {
        const status = options.status;
        log(`[reject-server] rejecting upgrade with HTTP ${status}`);
        socket.write(
          `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}\r\n` +
            'Connection: close\r\nContent-Length: 0\r\n\r\n',
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
        const err = options.preSettleError;
        if (err) {
          log(`[reject-server] sending pre-settle error (${err.code}) then closing`);
          ws.send(
            JSON.stringify({
              type: 'error',
              error: {
                type: err.type || 'invalid_request_error',
                code: err.code,
                message: err.message,
              },
            }),
          );
          setTimeout(() => ws.close(err.closeCode || 1013, err.closeReason || ''), 30);
          return;
        }
        log('[reject-server] accepted upgrade; going silent (handshake timeout)');
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      const boundPort = address.port;
      /** @type {RejectServerHandle} */
      const handle = {
        host,
        port: boundPort,
        url: `ws://${host}:${boundPort}`,
        close() {
          return new Promise((res) => {
            for (const client of wss.clients) client.terminate();
            server.close(() => res());
          });
        },
      };
      log(`[reject-server] listening on ${handle.url}`);
      resolve(handle);
    });
  });
}

module.exports = { createRejectServer };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  /** @param {string} name */
  const get = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const status = get('--status') ? Number(get('--status')) : undefined;
  const code = get('--error-code');
  /** @type {RejectServerOptions} */
  const opts = {
    port: get('--port') ? Number(get('--port')) : 8125,
    log: (line) => console.log(line),
  };
  if (status) opts.status = status;
  if (code) {
    opts.preSettleError = {
      code,
      message: get('--error-message') || `mock pre-settle error (${code})`,
    };
  }
  createRejectServer(opts).catch((err) => {
    console.error('[reject-server] failed to start:', err);
    process.exit(1);
  });
}
