import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const VERSION = 1;
interface Key { id: number; key: Buffer }

/**
 * AES-256-GCM field encryption with key rotation and a separate HMAC key for blind indexes.
 * Layout: [version=1][keyId][iv 12][tag 16][ciphertext]. `aad` binds the ciphertext to its tenant and purpose,
 * so a value copied into another row or tenant fails to decrypt.
 */
export class FieldCrypto {
  private readonly keys: Map<number, Buffer>;
  private readonly current: Key;
  private readonly blindKey: Buffer;

  constructor(spec: string, blindKeyB64: string) {
    const parsed: Key[] = spec.split(',').map((part) => {
      const [id, b64] = part.split(':') as [string, string];
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error('field encryption keys must be 32 bytes');
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error('field encryption key ids must be 1-255');
      return { id: n, key };
    });
    if (new Set(parsed.map((k) => k.id)).size !== parsed.length) throw new Error('duplicate field encryption key id');
    this.keys = new Map(parsed.map((k) => [k.id, k.key]));
    this.current = parsed[0]!;
    this.blindKey = Buffer.from(blindKeyB64, 'base64');
    if (this.blindKey.length !== 32) throw new Error('blind index key must be 32 bytes');
    if (this.blindKey.equals(this.current.key)) throw new Error('the blind index key must differ from the encryption key');
  }

  encrypt(plain: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.current.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION, this.current.id]), iv, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): string {
    if (blob.length < 30 || blob[0] !== VERSION) throw new Error('unrecognised ciphertext');
    const key = this.keys.get(blob[1]!);
    if (!key) throw new Error('unknown encryption key id');
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(2, 14));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(14, 30));
    return Buffer.concat([d.update(blob.subarray(30)), d.final()]).toString('utf8');
  }

  /** True when the value was written with an older key and should be re-encrypted. */
  needsRotation(blob: Buffer): boolean { return blob[1] !== this.current.id; }

  blindIndex(tenantId: string, kind: string, normalisedValue: string): Buffer {
    return createHmac('sha256', this.blindKey).update(`${tenantId}\u0000${kind}\u0000${normalisedValue}`).digest();
  }
}

/** Only the last characters of a secret ever leave the API. */
export const maskLast = (last: string | null | undefined): string => `••••••${last ?? ''}`;
