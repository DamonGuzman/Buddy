/**
 * Direct unit tests for the web_fetch SSRF guard's v4/v6 range math and the
 * markup sanitizer (src/main/agents/tools/web-fetch.ts). The network-level
 * localhost/private blocking behavior is covered in tests/agent-mode.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isPrivateAddress,
  pinnedRequestOptions,
  safeFetch,
  sanitize,
  type SafeFetchDependencies,
  type SafeFetchResponse,
} from '../src/main/agents/tools/web-fetch';

function response(
  url: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): SafeFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    url,
    text: async () => 'ok',
  };
}

describe('isPrivateAddress — IPv4 ranges', () => {
  it.each([
    ['0.0.0.1', true], // "this network"
    ['10.0.0.1', true], // RFC1918 10/8
    ['10.255.255.255', true],
    ['100.64.0.1', true], // shared address space / CGNAT
    ['100.100.100.200', true], // metadata endpoint inside shared space
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['127.0.0.1', true], // loopback
    ['169.254.1.1', true], // link-local
    ['169.253.1.1', false], // just below link-local
    ['169.255.1.1', false], // just above link-local
    ['172.15.255.255', false], // below RFC1918 172.16/12
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // above RFC1918 172.16/12
    ['192.168.1.1', true], // RFC1918 192.168/16
    ['192.0.0.8', true], // IETF special-purpose
    ['192.0.0.9', false], // globally reachable PCP anycast exception
    ['192.0.0.10', false], // globally reachable TURN anycast exception
    ['192.0.2.1', true], // documentation
    ['192.88.99.1', true], // deprecated 6to4 relay
    ['192.167.1.1', false],
    ['192.169.1.1', false],
    ['198.18.0.1', true], // benchmarking
    ['198.51.100.1', true], // documentation
    ['203.0.113.7', true], // documentation
    ['223.255.255.255', false], // last globally routable unicast block
    ['224.0.0.1', true], // multicast
    ['255.255.255.255', true], // broadcast / reserved
    ['8.8.8.8', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('isPrivateAddress — IPv6 ranges', () => {
  it.each([
    ['::1', true], // loopback
    ['::', true], // unspecified
    ['fc00::1', true], // ULA fc00::/7
    ['fd12:3456::1', true],
    ['fe80::1', true], // link-local fe80::/10
    ['fe9f::1', true],
    ['fea0::1', true],
    ['febf::1', true],
    ['fec0::1', true], // deprecated site-local / outside global 2000::/3
    ['fe00::1', true],
    ['ff02::1', true], // multicast
    ['2001:db8::1', true], // documentation
    ['2001:2::1', true], // benchmarking
    ['2002:0808:0808::1', true], // deprecated 6to4
    ['3fff::1', true], // documentation
    ['2001:4860:4860::8888', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it('unwraps v4-mapped v6 addresses (case-insensitive)', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::FFFF:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:6440:1')).toBe(true);
  });

  it('fails closed for non-IP resolver output', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('sanitize', () => {
  it('drops script/style bodies entirely, not just their tags', () => {
    expect(sanitize('a<script>alert("x")</script>b<style>.c{color:red}</style>d')).toBe('a b d');
  });

  it('strips remaining markup and decodes basic entities', () => {
    expect(sanitize('<p>fish &amp; chips&nbsp;&lt;fresh&gt;</p>')).toBe('fish & chips <fresh>');
  });

  it('collapses all whitespace runs to single spaces', () => {
    expect(sanitize('  a\n\n b\t\tc  ')).toBe('a b c');
  });
});

describe('safeFetch pinned transport', () => {
  it('uses exactly the validated public address without a second resolver lookup', async () => {
    let resolverCalls = 0;
    const connected: string[] = [];
    const dependencies: SafeFetchDependencies = {
      resolve: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      request: async (url, destination) => {
        connected.push(destination.address);
        return response(url.toString());
      },
    };

    await expect(
      safeFetch(
        new URL('https://rebind.example/resource'),
        new AbortController().signal,
        dependencies,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(resolverCalls).toBe(1);
    expect(connected).toEqual(['93.184.216.34']);
  });

  it('revalidates every redirect hop and blocks an alternating private DNS answer', async () => {
    let resolverCalls = 0;
    const request = vi.fn(async (url: URL) =>
      response(url.toString(), 302, { location: '/redirected' }),
    );
    const dependencies: SafeFetchDependencies = {
      resolve: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      request,
    };

    await expect(
      safeFetch(
        new URL('https://rebind.example/start'),
        new AbortController().signal,
        dependencies,
      ),
    ).rejects.toThrow('private addresses are blocked');
    expect(resolverCalls).toBe(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it('denies mixed public/private resolver results before transport', async () => {
    const request = vi.fn();
    await expect(
      safeFetch(new URL('https://mixed.example/'), new AbortController().signal, {
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.7', family: 4 },
        ],
        request,
      }),
    ).rejects.toThrow('private addresses are blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the socket IP while preserving HTTPS Host, SNI, and request path identity', () => {
    const options = pinnedRequestOptions(
      new URL('https://Accounts.Example.com:8443/login?next=%2Fhome'),
      { address: '93.184.216.34', family: 4 },
    );

    expect(options).toMatchObject({
      protocol: 'https:',
      hostname: '93.184.216.34',
      family: 4,
      port: '8443',
      path: '/login?next=%2Fhome',
      servername: 'accounts.example.com',
    });
    expect(options.headers).toMatchObject({
      Host: 'accounts.example.com:8443',
      'Accept-Encoding': 'identity',
    });
    expect(options).not.toHaveProperty('rejectUnauthorized', false);
  });

  it('rejects URL credentials and invalid explicit port zero before transport', async () => {
    const dependencies: SafeFetchDependencies = {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: vi.fn(),
    };
    await expect(
      safeFetch(
        new URL('https://user:pass@example.com/'),
        new AbortController().signal,
        dependencies,
      ),
    ).rejects.toThrow('url credentials are blocked');
    await expect(
      safeFetch(new URL('https://example.com:0/'), new AbortController().signal, dependencies),
    ).rejects.toThrow('url port is invalid');
  });
});
