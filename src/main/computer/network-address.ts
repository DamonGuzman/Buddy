import { isIP } from 'node:net';

/** Fail-closed classifier used by Buddy's local browser and proxy SSRF boundaries. */
export function isPrivateAddress(address: string): boolean {
  return !isGlobalUnicastAddress(address);
}

export function isGlobalUnicastAddress(address: string): boolean {
  const raw = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(raw);
  if (family === 4) return isGlobalIPv4(parseIPv4(raw));
  if (family !== 6) return false;

  const value = parseIPv6(raw);
  if (value === null) return false;
  if (value >> 32n === 0xffffn) return isGlobalIPv4(Number(value & 0xffff_ffffn));
  if (!inCidr(value, ipv6('2000::'), 3, 128)) return false;
  if (inCidr(value, ipv6('2001::'), 23, 128)) return false;
  if (inCidr(value, ipv6('2001:db8::'), 32, 128)) return false;
  if (inCidr(value, ipv6('2002::'), 16, 128)) return false;
  if (inCidr(value, ipv6('3fff::'), 20, 128)) return false;
  return true;
}

function isGlobalIPv4(value: number): boolean {
  if (inCidr4(value, '0.0.0.0', 8)) return false;
  if (inCidr4(value, '10.0.0.0', 8)) return false;
  if (inCidr4(value, '100.64.0.0', 10)) return false;
  if (inCidr4(value, '127.0.0.0', 8)) return false;
  if (inCidr4(value, '169.254.0.0', 16)) return false;
  if (inCidr4(value, '172.16.0.0', 12)) return false;
  if (inCidr4(value, '192.0.0.0', 24)) {
    return value === parseIPv4('192.0.0.9') || value === parseIPv4('192.0.0.10');
  }
  if (inCidr4(value, '192.0.2.0', 24)) return false;
  if (inCidr4(value, '192.88.99.0', 24)) return false;
  if (inCidr4(value, '192.168.0.0', 16)) return false;
  if (inCidr4(value, '198.18.0.0', 15)) return false;
  if (inCidr4(value, '198.51.100.0', 24)) return false;
  if (inCidr4(value, '203.0.113.0', 24)) return false;
  if (inCidr4(value, '224.0.0.0', 4)) return false;
  if (inCidr4(value, '240.0.0.0', 4)) return false;
  return true;
}

function inCidr4(value: number, network: string, prefix: number): boolean {
  const shift = 32 - prefix;
  return value >>> shift === parseIPv4(network) >>> shift;
}

function parseIPv4(address: string): number {
  return (
    address
      .split('.')
      .map(Number)
      .reduce((value, octet) => value * 256 + octet, 0) >>> 0
  );
}

function ipv6(address: string): bigint {
  const value = parseIPv6(address);
  if (value === null) throw new Error(`invalid internal IPv6 constant: ${address}`);
  return value;
}

function parseIPv6(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  let normalized = address;
  const dotted = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const value = parseIPv4(dotted);
    normalized = `${normalized.slice(0, -dotted.length)}${(value >>> 16).toString(16)}:${(
      value & 0xffff
    ).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(omitted).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  return value;
}

function inCidr(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === network >> shift;
}
