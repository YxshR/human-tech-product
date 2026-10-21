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
