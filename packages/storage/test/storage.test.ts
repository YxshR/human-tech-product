import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStorage, buildStorage } from '../src';

const dir = mkdtemp(join(tmpdir(), 'ht-storage-'));
afterAll(async () => rm(await dir, { recursive: true, force: true }));
const key = (purpose = 'payslip') => `${randomUUID()}/${purpose}/${randomUUID()}`;

describe('LocalFileStorage', () => {
  it('stores, reads and deletes', async () => {
    const s = new LocalFileStorage(await dir); const k = key();
    await s.put(k, Buffer.from('hello'), 'text/plain');
    expect((await s.get(k)).toString()).toBe('hello');
    await s.delete(k); await expect(s.get(k)).rejects.toThrow();
    await s.delete(k);                                        // deleting twice is fine
  });
  it('refuses keys that are not <tenant>/<purpose>/<id>', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'ht-storage-bad-'));
    const s = new LocalFileStorage(fresh);
    for (const bad of ['../etc/passwd', `${randomUUID()}/../../x`, 'plain', `${randomUUID()}/Payslip/${randomUUID()}`, `${randomUUID()}/payslip/../../${randomUUID()}`]) {
      await expect(s.put(bad, Buffer.from('x'), 'text/plain')).rejects.toThrow(/invalid storage key/);
      await expect(s.get(bad)).rejects.toThrow(/invalid storage key/);
    }
    expect(await readdir(fresh)).toEqual([]);
    await rm(fresh, { recursive: true, force: true });
  });
  it('buildStorage validates its options', async () => {
    expect(buildStorage({ driver: 'local', localDir: await dir })).toBeInstanceOf(LocalFileStorage);
    expect(() => buildStorage({ driver: 'local' })).toThrow();
    expect(() => buildStorage({ driver: 's3' })).toThrow();
  });
});
