import { describe, expect, it } from 'vitest';
import {
  asFiniteNumber,
  asRecord,
  asString,
  errorMessage,
  pushCapped,
} from '../src/main/util/guards';

describe('asRecord', () => {
  it('passes plain objects through unchanged', () => {
    const obj = { a: 1, b: 'two' };
    expect(asRecord(obj)).toBe(obj);
    expect(asRecord({})).toEqual({});
  });

  it('rejects arrays (debug-server semantics)', () => {
    expect(asRecord([])).toBeNull();
    expect(asRecord([{ a: 1 }])).toBeNull();
  });

  it('rejects null and primitives', () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord('x')).toBeNull();
    expect(asRecord(3)).toBeNull();
    expect(asRecord(true)).toBeNull();
  });
});

describe('asString', () => {
  it('returns strings as-is, including empty', () => {
    expect(asString('hello')).toBe('hello');
    expect(asString('')).toBe('');
  });

  it("returns '' for non-strings without coercing", () => {
    expect(asString(3)).toBe('');
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
    expect(asString({ toString: () => 'nope' })).toBe('');
  });
});

describe('asFiniteNumber', () => {
  it('returns finite numbers, including 0 and negatives', () => {
    expect(asFiniteNumber(42)).toBe(42);
    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(-1.5)).toBe(-1.5);
  });

  it('rejects NaN, infinities, and non-numbers', () => {
    expect(asFiniteNumber(Number.NaN)).toBeNull();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber('3')).toBeNull();
    expect(asFiniteNumber(null)).toBeNull();
    expect(asFiniteNumber(undefined)).toBeNull();
  });
});

describe('errorMessage', () => {
  it('extracts the message from Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(7)).toBe('7');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('pushCapped', () => {
  it('mutates and returns the same array while under the cap', () => {
    const arr = [1, 2];
    const out = pushCapped(arr, 3, 3);
    expect(out).toBe(arr);
    expect(out).toEqual([1, 2, 3]);
  });

  it('returns a fresh last-limit slice once the cap overflows', () => {
    const arr = [1, 2, 3];
    const out = pushCapped(arr, 4, 3);
    expect(out).not.toBe(arr);
    expect(out).toEqual([2, 3, 4]);
    // Matches the hand-rolled idiom: the original was pushed onto first.
    expect(arr).toEqual([1, 2, 3, 4]);
  });

  it('keeps exactly the newest items across repeated pushes', () => {
    let arr: number[] = [];
    for (let i = 0; i < 10; i += 1) arr = pushCapped(arr, i, 4);
    expect(arr).toEqual([6, 7, 8, 9]);
  });
});
