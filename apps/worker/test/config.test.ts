import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('worker config', () => {
  const ok = { DATABASE_URL: 'postgres://app@h/db', DATABASE_SYSTEM_URL: 'postgres://sys@h/db' };
  it('loads defaults', () => expect(loadConfig(ok).WORKER_CONCURRENCY).toBe(4));
  it('fails fast listing every problem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*DATABASE_SYSTEM_URL/);
  });
  it('refuses to run the queue and handlers on the same database role/url', () => {
    expect(() => loadConfig({ DATABASE_URL: ok.DATABASE_URL, DATABASE_SYSTEM_URL: ok.DATABASE_URL })).toThrow(/different roles/);
  });
});

describe('worker config: mail and storage', () => {
  const ok = { DATABASE_URL: 'postgres://app@h/db', DATABASE_SYSTEM_URL: 'postgres://sys@h/db' };
  it('requires SMTP in production only', () => {
    expect(() => loadConfig({ ...ok, NODE_ENV: 'production' })).toThrow(/SMTP_URL/);
    expect(loadConfig({ ...ok, NODE_ENV: 'production', SMTP_URL: 'smtp://mail:1025' }).SMTP_URL).toBe('smtp://mail:1025');
    expect(loadConfig(ok).SMTP_URL).toBeUndefined();
  });
  it('s3 storage needs credentials', () => {
    expect(() => loadConfig({ ...ok, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(loadConfig({ ...ok, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' }).STORAGE_DRIVER).toBe('s3');
  });
});
