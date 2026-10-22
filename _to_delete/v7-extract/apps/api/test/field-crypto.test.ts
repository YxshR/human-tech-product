import { describe, expect, it } from 'vitest';
import { FieldCrypto, maskLast } from '../src/security/field-crypto';

const k = (n: number) => Buffer.alloc(32, n).toString('base64');
const T1 = '11111111-1111-4111-8111-111111111111'; const T2 = '22222222-2222-4222-8222-222222222222';

describe('FieldCrypto', () => {
  const c = new FieldCrypto(`1:${k(1)}`, k(9));
  it('round-trips and never repeats a ciphertext', () => {
    const a = c.encrypt('ABCDE1234F', 'aad'); const b = c.encrypt('ABCDE1234F', 'aad');
    expect(a.equals(b)).toBe(false); expect(c.decrypt(a, 'aad')).toBe('ABCDE1234F'); expect(a.toString('latin1')).not.toContain('ABCDE');
  });
  it('rejects a different context, tampering and truncation', () => {
    const a = c.encrypt('secret', `${T1}:bank:e1`);
    expect(() => c.decrypt(a, `${T2}:bank:e1`)).toThrow();
    const t = Buffer.from(a); t[t.length - 1] ^= 1;
    expect(() => c.decrypt(t, `${T1}:bank:e1`)).toThrow();
    expect(() => c.decrypt(a.subarray(0, 20), `${T1}:bank:e1`)).toThrow();
  });
  it('supports key rotation: old data stays readable, new data uses the first key', () => {
    const old = c.encrypt('legacy', 'x');
    const rotated = new FieldCrypto(`2:${k(2)},1:${k(1)}`, k(9));
    expect(rotated.decrypt(old, 'x')).toBe('legacy'); expect(rotated.needsRotation(old)).toBe(true);
    const fresh = rotated.encrypt('new', 'x'); expect(rotated.needsRotation(fresh)).toBe(false);
    expect(() => c.decrypt(fresh, 'x')).toThrow(/unknown encryption key/);
  });
  it('blind indexes are deterministic, tenant-separated and kind-separated', () => {
    expect(c.blindIndex(T1, 'pan', 'ABCDE1234F').equals(c.blindIndex(T1, 'pan', 'ABCDE1234F'))).toBe(true);
    expect(c.blindIndex(T1, 'pan', 'ABCDE1234F').equals(c.blindIndex(T2, 'pan', 'ABCDE1234F'))).toBe(false);
    expect(c.blindIndex(T1, 'pan', 'ABCDE1234F').equals(c.blindIndex(T1, 'uan', 'ABCDE1234F'))).toBe(false);
  });
  it('validates its keys', () => {
    expect(() => new FieldCrypto(`1:${Buffer.alloc(16).toString('base64')}`, k(9))).toThrow(/32 bytes/);
    expect(() => new FieldCrypto(`1:${k(1)},1:${k(2)}`, k(9))).toThrow(/duplicate/);
    expect(() => new FieldCrypto(`1:${k(1)}`, k(1))).toThrow(/differ/);
    expect(() => new FieldCrypto(`0:${k(1)}`, k(9))).toThrow(/1-255/);
  });
  it('masks to the last characters only', () => { expect(maskLast('234F')).toBe('••••••234F'); expect(maskLast(null)).toBe('••••••'); });
});
