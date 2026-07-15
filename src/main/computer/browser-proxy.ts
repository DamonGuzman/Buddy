import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isPrivateAddress } from '../agents/tools/web-fetch';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_HEADERS = 128;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type BrowserProxyResolver = (hostname: string) => Promise<ProxyResolvedAddress[]>;
export type BrowserProxyDestinationGuard = (url: URL) => Promise<void>;

export interface BuddyBrowserProxyOptions {
  destinationGuard: BrowserProxyDestinationGuard;
  /** True only for a test fixture whose custom guard deliberately authorizes loopback. */
  allowPrivateDestinations?: boolean;
  resolver?: BrowserProxyResolver;
  timeoutMs?: number;
  logger?: { warn(message: string): void };
}

export interface BrowserProxyCredentials {
  username: string;
  password: string;
}

/**
 * Session-scoped forward proxy that pins every connection to one already-validated DNS result.
 * Chromium sees only this loopback endpoint; it never resolves or directly connects to the target.
 */
export class BuddyBrowserProxy {
  private readonly resolver: BrowserProxyResolver;
  private readonly timeoutMs: number;
  private readonly logger: { warn(message: string): void };
  private readonly credentials: BrowserProxyCredentials = {
    username: 'buddy',
    password: randomBytes(32).toString('base64url'),
  };
  private readonly expectedAuthorization: Buffer;
  private readonly sockets = new Set<Socket>();
  private readonly server;
  private startPromise: Promise<number> | null = null;
  private boundPort: number | null = null;
  private disposed = false;

  constructor(private readonly options: BuddyBrowserProxyOptions) {
    this.resolver = options.resolver ?? systemResolver;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(this.timeoutMs > 0)) throw new Error('browser proxy timeout must be positive');
    this.logger = options.logger ?? { warn: (message) => console.warn(message) };
    this.expectedAuthorization = Buffer.from(
      `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`,
      'utf8',
    );
    this.server = createServer(
      { maxHeaderSize: MAX_HEADER_BYTES },
      (request, response) => void this.forwardHttp(request, response),
    );
    this.server.maxHeadersCount = MAX_HEADERS;
    this.server.requestTimeout = this.timeoutMs;
    this.server.headersTimeout = this.timeoutMs;
    this.server.keepAliveTimeout = Math.min(this.timeoutMs, 5_000);
    this.server.on('connect', (request, client, head) => {
      void this.forwardConnect(request, client, head);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  start(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('buddy browser proxy is disposed'));
    this.startPromise ??= new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('buddy browser proxy did not bind a TCP port'));
          return;
        }
        this.boundPort = (address as AddressInfo).port;
        resolve(this.boundPort);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
    return this.startPromise;
  }

  /** Credentials are process-local and unique to this proxy instance. */
  getCredentials(): Readonly<BrowserProxyCredentials> {
    return { ...this.credentials };
  }

  isOwnEndpoint(host: string, port: number): boolean {
    return host === '127.0.0.1' && this.boundPort === port;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.startPromise;
    } catch {
      // A failed bind has no listener to close.
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.assertAuthorized(request.headers['proxy-authorization']);
      const url = parseAbsoluteHttpUrl(request.url);
      await this.options.destinationGuard(url);
      const pinned = await this.resolvePinned(url.hostname);
      const headers = sanitizedHeaders(request.headers);
      headers['host'] = url.host;
      const upstream = httpRequest({
        hostname: pinned.address,
        family: pinned.family,
        port: validatedPort(url.port, 80),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: this.timeoutMs,
      });
      upstream.once('timeout', () => upstream.destroy(new Error('upstream request timed out')));
      upstream.once('error', (error) => {
        if (!response.headersSent) sendHttpError(response, 502, 'Bad Gateway');
        else response.destroy(error);
      });
      upstream.once('response', (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      });
      request.pipe(upstream);
    } catch (error) {
      this.logger.warn(`[browser-proxy] blocked HTTP request: ${errorMessage(error)}`);
      if (error instanceof ProxyAuthenticationError) {
        sendProxyAuthenticationRequired(response);
      } else {
        sendHttpError(response, policyStatus(error), 'Blocked');
      }
    }
  }

  private async forwardConnect(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    let upstream: Socket | null = null;
    try {
      this.assertAuthorized(request.headers['proxy-authorization']);
      const url = parseConnectAuthority(request.url);
      await this.options.destinationGuard(url);
      const pinned = await this.resolvePinned(url.hostname);
      upstream = netConnect({
        host: pinned.address,
        family: pinned.family,
        port: validatedPort(url.port, 443),
      });
      const connectedSocket = upstream;
      this.sockets.add(connectedSocket);
      connectedSocket.once('close', () => this.sockets.delete(connectedSocket));
      upstream.setTimeout(this.timeoutMs, () => upstream?.destroy(new Error('CONNECT timed out')));
      await onceConnected(upstream);
      client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Buddy\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      this.logger.warn(`[browser-proxy] blocked CONNECT: ${errorMessage(error)}`);
      upstream?.destroy();
      if (client.writable) {
        if (error instanceof ProxyAuthenticationError) {
          client.end(
            'HTTP/1.1 407 Proxy Authentication Required\r\n' +
              'Proxy-Authenticate: Basic realm="Buddy browser proxy"\r\n' +
              'Connection: close\r\n\r\n',
          );
        } else {
          client.end(`HTTP/1.1 ${policyStatus(error)} Blocked\r\nConnection: close\r\n\r\n`);
        }
      } else {
        client.destroy();
      }
    }
  }

  private assertAuthorized(header: string | string[] | undefined): void {
    if (typeof header !== 'string') throw new ProxyAuthenticationError();
    const supplied = Buffer.from(header, 'utf8');
    if (
      supplied.length !== this.expectedAuthorization.length ||
      !timingSafeEqual(supplied, this.expectedAuthorization)
    ) {
      throw new ProxyAuthenticationError();
    }
  }

  private async resolvePinned(hostname: string): Promise<ProxyResolvedAddress> {
    const addresses = await this.resolver(hostname);
    if (addresses.length === 0) throw new ProxyPolicyError('destination did not resolve');
    if (
      !this.options.allowPrivateDestinations &&
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new ProxyPolicyError('destination resolved to a private or mixed address set');
    }
    const selected = addresses[0];
    if (!selected) throw new ProxyPolicyError('destination did not resolve');
    return selected;
  }
}

class ProxyPolicyError extends Error {}
class ProxyAuthenticationError extends Error {
  constructor() {
    super('proxy authentication required');
  }
}

async function systemResolver(hostname: string): Promise<ProxyResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.flatMap((result) =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : [],
  );
}

function parseAbsoluteHttpUrl(raw: string | undefined): URL {
  if (!raw) throw new ProxyPolicyError('proxy request URL is missing');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyPolicyError('proxy request URL is invalid');
  }
  if (url.protocol !== 'http:') throw new ProxyPolicyError('HTTP proxy accepts only http URLs');
  if (url.username || url.password) throw new ProxyPolicyError('proxy URL credentials are blocked');
  return url;
}

function parseConnectAuthority(raw: string | undefined): URL {
  if (!raw || /[/?#]/.test(raw)) throw new ProxyPolicyError('CONNECT authority is invalid');
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    throw new ProxyPolicyError('CONNECT authority is invalid');
  }
  if (!url.hostname) throw new ProxyPolicyError('CONNECT hostname is missing');
  if (url.username || url.password) {
    throw new ProxyPolicyError('CONNECT authority credentials are blocked');
  }
  return url;
}

function validatedPort(raw: string, fallback: number): number {
  const port = raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyPolicyError('destination port is out of bounds');
  }
  return port;
}

function sanitizedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  return output;
}

function sendHttpError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    connection: 'close',
  });
  response.end(message);
}

function sendProxyAuthenticationRequired(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const message = 'Proxy Authentication Required';
  response.writeHead(407, {
    'proxy-authenticate': 'Basic realm="Buddy browser proxy"',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    connection: 'close',
  });
  response.end(message);
}

function onceConnected(socket: Socket): Promise<void> {
  if (socket.readyState === 'open') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function policyStatus(error: unknown): number {
  return error instanceof ProxyPolicyError ? 403 : 502;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
