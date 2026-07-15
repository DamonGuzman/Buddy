import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BuddyBrowserProxy } from '../src/main/computer/browser-proxy';
import type { BrowserProxyCredentials } from '../src/main/computer/browser-proxy';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('BuddyBrowserProxy', () => {
  it('resolves once and connects the exact pinned address despite an alternating resolver', async () => {
    let fixtureHits = 0;
    const fixture = createHttpServer((_request, response) => {
      fixtureHits += 1;
      response.end('pinned');
    });
    const fixturePort = await listen(fixture);
    cleanups.push(() => close(fixture));

    let resolutions = 0;
    const proxy = new BuddyBrowserProxy({
      destinationGuard: async () => undefined,
      allowPrivateDestinations: true,
      resolver: async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '10.0.0.9', family: 4 }];
      },
    });
    const proxyPort = await proxy.start();
    cleanups.push(() => proxy.dispose());

    const response = await requestThroughProxy(
      proxyPort,
      `http://rebind.test:${fixturePort}/`,
      proxy.getCredentials(),
    );
    expect(response).toEqual({ status: 200, body: 'pinned' });
    expect(resolutions).toBe(1);
    expect(fixtureHits).toBe(1);
  });

  it('rejects mixed public/private DNS results before making any connection', async () => {
    let fixtureHits = 0;
    const fixture = createHttpServer((_request, response) => {
      fixtureHits += 1;
      response.end('private');
    });
    const fixturePort = await listen(fixture);
    cleanups.push(() => close(fixture));

    const proxy = new BuddyBrowserProxy({
      destinationGuard: async () => undefined,
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    const proxyPort = await proxy.start();
    cleanups.push(() => proxy.dispose());

    const response = await requestThroughProxy(
      proxyPort,
      `http://mixed.test:${fixturePort}/`,
      proxy.getCredentials(),
    );
    expect(response.status).toBe(403);
    expect(fixtureHits).toBe(0);
  });

  it('pins CONNECT tunnels used by HTTPS and WSS while preserving opaque TLS bytes', async () => {
    const fixture = createNetServer((socket) => socket.pipe(socket));
    const fixturePort = await listen(fixture);
    cleanups.push(() => close(fixture));

    let resolutions = 0;
    const proxy = new BuddyBrowserProxy({
      destinationGuard: async () => undefined,
      allowPrivateDestinations: true,
      resolver: async () => {
        resolutions += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const proxyPort = await proxy.start();
    cleanups.push(() => proxy.dispose());

    const socket = netConnect(proxyPort, '127.0.0.1');
    cleanups.push(async () => {
      socket.destroy();
    });
    await connected(socket);
    socket.write(
      `CONNECT secure.test:${fixturePort} HTTP/1.1\r\n` +
        `Host: secure.test\r\n` +
        `Proxy-Authorization: ${authorization(proxy.getCredentials())}\r\n\r\n`,
    );
    const headers = await readUntil(socket, '\r\n\r\n');
    expect(headers).toContain('200 Connection Established');
    socket.write('opaque-tls-record');
    const echo = await readUntil(socket, 'opaque-tls-record');
    expect(echo).toContain('opaque-tls-record');
    expect(resolutions).toBe(1);
  });

  it.each([
    ['missing', undefined],
    ['incorrect', { username: 'buddy', password: 'wrong' }],
  ])('rejects %s HTTP proxy credentials before policy or DNS', async (_label, credentials) => {
    let guards = 0;
    let resolutions = 0;
    const proxy = new BuddyBrowserProxy({
      destinationGuard: async () => {
        guards += 1;
      },
      resolver: async () => {
        resolutions += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    const proxyPort = await proxy.start();
    cleanups.push(() => proxy.dispose());

    const response = await requestThroughProxy(proxyPort, 'http://example.test/', credentials);
    expect(response.status).toBe(407);
    expect(guards).toBe(0);
    expect(resolutions).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['incorrect', { username: 'buddy', password: 'wrong' }],
  ])('rejects %s CONNECT proxy credentials before policy or DNS', async (_label, credentials) => {
    let guards = 0;
    let resolutions = 0;
    const proxy = new BuddyBrowserProxy({
      destinationGuard: async () => {
        guards += 1;
      },
      resolver: async () => {
        resolutions += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    const proxyPort = await proxy.start();
    cleanups.push(() => proxy.dispose());

    const socket = netConnect(proxyPort, '127.0.0.1');
    cleanups.push(async () => {
      socket.destroy();
    });
    await connected(socket);
    socket.write(
      'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\n' +
        (credentials ? `Proxy-Authorization: ${authorization(credentials)}\r\n` : '') +
        '\r\n',
    );
    const response = await readUntil(socket, '\r\n\r\n');
    expect(response).toContain('407 Proxy Authentication Required');
    expect(guards).toBe(0);
    expect(resolutions).toBe(0);
  });
});

async function requestThroughProxy(
  proxyPort: number,
  target: string,
  credentials?: BrowserProxyCredentials,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: target,
        headers: {
          host: new URL(target).host,
          ...(credentials === undefined
            ? {}
            : { 'proxy-authorization': authorization(credentials) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function authorization(credentials: BrowserProxyCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function connected(socket: Socket): Promise<void> {
  if (socket.readyState === 'open') return;
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

async function readUntil(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), 2_000);
    const onData = (chunk: Buffer): void => {
      value += chunk.toString();
      if (!value.includes(marker)) return;
      clearTimeout(timeout);
      socket.off('data', onData);
      resolve(value);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}
