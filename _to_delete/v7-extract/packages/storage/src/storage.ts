import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Private object storage. Keys are always `<tenantId>/<purpose>/<random>`; nothing here is ever public. */
export interface FileStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z_]+\/[0-9a-f-]{36}$/;
const assertKey = (key: string): void => { if (!KEY_RE.test(key)) throw new Error('invalid storage key'); };

export class LocalFileStorage implements FileStorage {
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  private path(key: string): string {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data, { mode: 0o600 }); }
  async get(key: string): Promise<Buffer> { return readFile(this.path(key)); }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
}

export class S3FileStorage implements FileStorage {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, o: { endpoint?: string; region: string; accessKey: string; secretKey: string; forcePathStyle: boolean }) {
    this.s3 = new S3Client({ region: o.region, endpoint: o.endpoint, forcePathStyle: o.forcePathStyle, credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey } });
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256', ChecksumSHA256: createHash('sha256').update(data).digest('base64') }));
  }
  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string): Promise<void> { assertKey(key); await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export interface StorageOptions {
  driver: 'local' | 's3';
  localDir?: string;
  s3?: { bucket: string; endpoint?: string; region: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
}
export function buildStorage(o: StorageOptions): FileStorage {
  if (o.driver === 'local') {
    if (!o.localDir) throw new Error('local storage needs a directory');
    return new LocalFileStorage(o.localDir);
  }
  if (!o.s3) throw new Error('s3 storage needs bucket and credentials');
  return new S3FileStorage(o.s3.bucket, o.s3);
}
