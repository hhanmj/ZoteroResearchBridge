// 纯 JS MD5（用于校验 S3 ETag；S3 简单 PUT 的 ETag = 内容 MD5 的 hex）
// 无依赖，可独立单测。

function toUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function md5Block(digestBuf: Int32Array, block: Uint8Array, offset: number): void {
  const M = new Int32Array(16);
  const dv = new DataView(block.buffer, block.byteOffset + offset, 64);
  for (let i = 0; i < 16; i++) M[i] = dv.getInt32(i * 4, true);

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  // 常量表按需计算避免 64 项手写
  let a = digestBuf[0]!, b = digestBuf[1]!, c = digestBuf[2]!, d = digestBuf[3]!;
  const add = (x: number, y: number) => (x + y) | 0;
  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) | 0;

  for (let i = 0; i < 64; i++) {
    let f = 0, g = 0;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
    else { f = c ^ (b | ~d); g = (7 * i) % 16; }
    const tmp = d;
    d = c;
    c = b;
    b = add(b, rol(add(a, add(f, add(M[g]!, Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)))), S[i]!));
    a = tmp;
  }
  digestBuf[0] = add(digestBuf[0]!, a);
  digestBuf[1] = add(digestBuf[1]!, b);
  digestBuf[2] = add(digestBuf[2]!, c);
  digestBuf[3] = add(digestBuf[3]!, d);
}

export function md5(data: Uint8Array): string {
  const len = data.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(data);
  withPad[len] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, (len << 3) >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(len / 0x20000000), true);

  const st = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  for (let off = 0; off < withPad.length; off += 64) md5Block(st, withPad, off);

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) odv.setInt32(i * 4, st[i]!, true);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function md5HexOfText(text: string): string {
  return md5(toUtf8(text));
}
