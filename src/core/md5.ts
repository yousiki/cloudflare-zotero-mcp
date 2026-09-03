/**
 * Incremental MD5. WebCrypto's digest is one-shot, so a streamed upload has to
 * hash chunks as they pass through rather than holding the file.
 */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export class Md5Hasher {
  private a0 = 0x67452301;
  private b0 = 0xefcdab89;
  private c0 = 0x98badcfe;
  private d0 = 0x10325476;
  private readonly tail = new Uint8Array(64);
  private tailLength = 0;
  private byteLength = 0;

  update(chunk: Uint8Array): void {
    this.byteLength += chunk.byteLength;
    let offset = 0;
    if (this.tailLength > 0) {
      const need = 64 - this.tailLength;
      if (chunk.byteLength < need) {
        this.tail.set(chunk, this.tailLength);
        this.tailLength += chunk.byteLength;
        return;
      }
      this.tail.set(chunk.subarray(0, need), this.tailLength);
      this.compress(this.tail, 0);
      this.tailLength = 0;
      offset = need;
    }
    while (offset + 64 <= chunk.byteLength) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.byteLength) {
      this.tail.set(chunk.subarray(offset));
      this.tailLength = chunk.byteLength - offset;
    }
  }

  digest(): string {
    const originalBits = this.byteLength * 8;
    const padded = new Uint8Array(this.tailLength >= 56 ? 128 : 64);
    padded.set(this.tail.subarray(0, this.tailLength));
    padded[this.tailLength] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.byteLength - 8, originalBits >>> 0, true);
    view.setUint32(padded.byteLength - 4, Math.floor(originalBits / 2 ** 32), true);
    this.compress(padded, 0);
    if (padded.byteLength === 128) this.compress(padded, 64);

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, this.a0, true);
    outView.setUint32(4, this.b0, true);
    outView.setUint32(8, this.c0, true);
    outView.setUint32(12, this.d0, true);
    return toHex(out);
  }

  private compress(source: Uint8Array, offset: number): void {
    const view = new DataView(source.buffer, source.byteOffset + offset, 64);
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(i * 4, true);

    let A = this.a0;
    let B = this.b0;
    let C = this.c0;
    let D = this.d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + (K[i] as number) + (M[g] as number)) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = S[i] as number;
      B = (B + (((F << shift) | (F >>> (32 - shift))) >>> 0)) >>> 0;
    }

    this.a0 = (this.a0 + A) >>> 0;
    this.b0 = (this.b0 + B) >>> 0;
    this.c0 = (this.c0 + C) >>> 0;
    this.d0 = (this.d0 + D) >>> 0;
  }
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

export function md5Fallback(input: Uint8Array): string {
  const hasher = new Md5Hasher();
  hasher.update(input);
  return hasher.digest();
}
