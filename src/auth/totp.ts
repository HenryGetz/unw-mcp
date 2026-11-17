// RFC 6238 TOTP, dependency-free (verified against the RFC SHA-1 test vectors
// during recon). Used only for the Microsoft Entra fallback sign-in.
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode RFC 4648 base32 (padding optional, case-insensitive). */
export function base32Decode(input: string): Buffer {
  const clean = String(input)
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate the current code for a base32 secret. */
export function totp(
  secret: string,
  { digits = 6, step = 30, algorithm = "sha1", at = Date.now() }: {
    digits?: number;
    step?: number;
    algorithm?: string;
    at?: number;
  } = {},
): string {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac(algorithm, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Seconds until the current window rolls over; avoids submitting a stale code. */
export function secondsRemaining({ step = 30, at = Date.now() }: { step?: number; at?: number } = {}): number {
  return step - (Math.floor(at / 1000) % step);
}
