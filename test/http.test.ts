import { describe, expect, test } from 'bun:test';
import {
  BackoffGate,
  base64Decode,
  base64Encode,
  Limiter,
  md5Hex,
  parseRetryAfter,
} from '../src/core/http.js';

const utf8 = (value: string) => new TextEncoder().encode(value);

describe('md5Hex', () => {
  test('matches known digests', async () => {
    expect(await md5Hex(utf8(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(await md5Hex(utf8('hello world'))).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
    expect(await md5Hex(utf8('The quick brown fox jumps over the lazy dog'))).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    );
  });

  test('handles input spanning multiple 64-byte blocks', async () => {
    expect(await md5Hex(utf8('a'.repeat(1000)))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
  });
});

describe('base64', () => {
  test('round-trips binary data', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
  });
});

describe('parseRetryAfter', () => {
  test('reads seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  test('reads HTTP dates', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(5);
  });

  test('is zero for missing or garbage values', () => {
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter('soon')).toBe(0);
  });
});

describe('BackoffGate', () => {
  test('delays subsequent requests after a Backoff header', async () => {
    const gate = new BackoffGate();
    gate.noteResponse(new Response('', { headers: { Backoff: '0.05' } }));
    const start = Date.now();
    await gate.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  test('is a no-op without the header', async () => {
    const gate = new BackoffGate();
    gate.noteResponse(new Response(''));
    const start = Date.now();
    await gate.wait();
    expect(Date.now() - start).toBeLessThan(20);
  });
});

describe('Limiter', () => {
  test('never runs more than max tasks at once', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
