import { afterAll, describe, expect, it } from 'vitest';
import { PAYROLL_STATUSES, canTransition, SQLSTATE_TO_ERROR } from '@humantech/contracts';
import { closePools, pools } from './helpers';

afterAll(closePools);

describe('contracts mirror the database', () => {
  it('every ordered payroll status pair agrees with app.payroll_run_transition_allowed', async () => {
    for (const a of PAYROLL_STATUSES) for (const b of PAYROLL_STATUSES) {
      const { rows } = await pools.admin.query('SELECT app.payroll_run_transition_allowed($1,$2) ok', [a, b]);
      expect(canTransition(a, b), `${a}->${b}`).toBe(rows[0].ok);
    }
  });
  it('every custom SQLSTATE the database raises has an API mapping', async () => {
    const { rows } = await pools.admin.query(`
      SELECT DISTINCT m[1] AS code FROM pg_proc p, regexp_matches(pg_get_functiondef(p.oid), 'ERRCODE = ''(HT[0-9]{3})''', 'g') m
       WHERE p.pronamespace = 'app'::regnamespace`);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect(SQLSTATE_TO_ERROR[r.code as string], r.code).toBeDefined();
  });
  it('database status CHECK list equals the contract list', async () => {
    const { rows } = await pools.admin.query(`
      SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='payroll_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%under_review%'`);
    const def = rows[0].d as string;
    for (const s of PAYROLL_STATUSES) expect(def).toContain(`'${s}'`);
  });
});
