/**
 * Direct unit tests for the web_fetch SSRF guard's v4/v6 range math and the
 * markup sanitizer (src/main/agents/tools/web-fetch.ts). The network-level
 * localhost/private blocking behavior is covered in tests/agent-mode.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { isPrivateAddress, sanitize } from '../src/main/agents/tools/web-fetch';

describe('isPrivateAddress — IPv4 ranges', () => {
  it.each([
    ['0.0.0.1', true], // "this network"
    ['10.0.0.1', true], // RFC1918 10/8
    ['10.255.255.255', true],
    ['127.0.0.1', true], // loopback
    ['169.254.1.1', true], // link-local
    ['169.253.1.1', false], // just below link-local
    ['169.255.1.1', false], // just above link-local
    ['172.15.255.255', false], // below RFC1918 172.16/12
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // above RFC1918 172.16/12
    ['192.168.1.1', true], // RFC1918 192.168/16
    ['192.167.1.1', false],
    ['192.169.1.1', false],
    ['223.255.255.255', false], // last unicast block
    ['224.0.0.1', true], // multicast
    ['255.255.255.255', true], // broadcast / reserved
    ['8.8.8.8', false],
    ['203.0.113.7', false],
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
    ['fec0::1', false], // outside fe80::/10
    ['fe00::1', false],
    ['2001:4860:4860::8888', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it('unwraps v4-mapped v6 addresses (case-insensitive)', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::FFFF:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats non-IP strings as not private (DNS resolution happens first)', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
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
