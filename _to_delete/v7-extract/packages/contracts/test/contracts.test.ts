import { describe, expect, it } from 'vitest';
import {
  SQLSTATE_TO_ERROR, createEmployee, decodeCursor, encodeCursor, money, updateEmployee,
} from '../src';

describe('employee contract', () => {
  const base = { firstName: ' Asha ', branchId: '7b1f6a2c-2d3e-4f5a-8b9c-0d1e2f3a4b5c' };
  it('trims, lowercases emails and rejects unknown keys (no mass assignment)', () => {
    const v = createEmployee.parse({ ...base, workEmail: 'ASHA@Example.com' });
    expect(v.firstName).toBe('Asha');
    expect(v.workEmail).toBe('asha@example.com');
    expect(() => createEmployee.parse({ ...base, tenantId: 'x' })).toThrow();
    expect(() => createEmployee.parse({ ...base, payrollEligible: true })).toThrow();
  });
  it('update requires the version being edited', () => {
    expect(() => updateEmployee.parse({ firstName: 'B' })).toThrow();
    expect(updateEmployee.parse({ firstName: 'B', version: 3 }).version).toBe(3);
  });
  it('rejects malformed phone numbers', () => {
    expect(() => createEmployee.parse({ ...base, phone: '98-76' })).toThrow();
  });
});

describe('money and cursors', () => {
  it('money is a decimal string', () => {
    expect(money.safeParse('1000.50').success).toBe(true);
    expect(money.safeParse(1000.5).success).toBe(false);
    expect(money.safeParse('1e3').success).toBe(false);
    expect(money.safeParse('10.123').success).toBe(false);
  });
  it('cursor round-trips and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(['2030-01-01T00:00:00Z', 'abc', 5]))).toEqual(['2030-01-01T00:00:00Z', 'abc', 5]);
    expect(() => decodeCursor('not-a-cursor')).toThrow('invalid cursor');
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow('invalid cursor');
  });
});

describe('error mapping', () => {
  it('maps every custom SQLSTATE', () => {
    for (const code of ['HT001', 'HT002', 'HT003', 'HT004', 'HT005', 'HT006']) expect(SQLSTATE_TO_ERROR[code]).toBeDefined();
    expect(SQLSTATE_TO_ERROR.HT004).toMatchObject({ code: 'maker_checker_violation', status: 403 });
  });
});
