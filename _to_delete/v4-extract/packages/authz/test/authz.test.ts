import { describe, expect, it } from 'vitest';
import {
  AuthContext, PERMISSION_KEYS, PermissionKey, ROLES, ROLE_KEYS, authorizeOnEmployee, differentActors,
  forbiddenFields, httpStatusFor, isPermissionKey, maskIdentifier, redact, requireMfaForCritical,
} from '../src';

const ctx = (over: Partial<AuthContext> & { perms?: PermissionKey[] } = {}): AuthContext => ({
  tenantId: 't1', userId: 'u1', employeeId: 'e-self',
  permissions: new Set(over.perms ?? []),
  branchScope: { mode: 'all' }, mfaVerified: true, ...over,
});

describe('catalogue', () => {
  it('every role permission exists in the catalogue', () => {
    for (const r of ROLE_KEYS) for (const p of ROLES[r].permissions) expect(isPermissionKey(p)).toBe(true);
  });
  it('permission keys are namespaced and unique', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const k of PERMISSION_KEYS) expect(k).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
  it('segregation of duties: no role both prepares and approves payroll', () => {
    for (const r of ROLE_KEYS) {
      const p = new Set<string>(ROLES[r].permissions);
      expect(p.has('payroll.calculate') && p.has('payroll.approve')).toBe(false);
      expect(p.has('salary.assign') && p.has('salary.approve_assignment')).toBe(false);
      expect(p.has('employee.update_bank') && p.has('employee.verify_bank')).toBe(false);
    }
  });
  it('company admin has no payroll, bank or salary permissions by default', () => {
    const p = ROLES.company_admin.permissions as readonly string[];
    expect(p.filter((x) => /^(payroll|salary|salary_structure)\./.test(x) || /bank/.test(x))).toEqual([]);
  });
  it('employee role is self-service only', () => {
    for (const p of ROLES.employee.permissions) expect(/own|request/.test(p)).toBe(true);
  });
  it('auditor has no write-style permissions', () => {
    for (const p of ROLES.auditor.permissions) expect(p).not.toMatch(/\.(create|update|manage|approve|delete|assign|lock|submit)/);
  });
  it('privileged roles require MFA', () => {
    for (const r of ['company_admin', 'hr_admin', 'finance_payroll', 'payroll_approver', 'auditor'] as const)
      expect(ROLES[r].requiresMfa).toBe(true);
  });
});

describe('authorizeOnEmployee', () => {
  it('denies other tenants first, as 404', () => {
    const d = authorizeOnEmployee(ctx({ perms: ['employee.read'] }), 'employee.read', { tenantId: 't2' });
    expect(d).toEqual({ allowed: false, reason: 'wrong_tenant' });
    expect(httpStatusFor('wrong_tenant')).toBe(404);
  });
  it('denies without permission as 403', () => {
    const d = authorizeOnEmployee(ctx(), 'employee.read', { tenantId: 't1' });
    expect(d).toEqual({ allowed: false, reason: 'missing_permission' });
    expect(httpStatusFor('missing_permission')).toBe(403);
  });
  it('enforces branch scope', () => {
    const c = ctx({ perms: ['employee.read'], branchScope: { mode: 'listed', branchIds: new Set(['b1']) } });
    expect(authorizeOnEmployee(c, 'employee.read', { tenantId: 't1', branchId: 'b1' }).allowed).toBe(true);
    expect(authorizeOnEmployee(c, 'employee.read', { tenantId: 't1', branchId: 'b2' }).allowed).toBe(false);
    expect(authorizeOnEmployee(c, 'employee.read', { tenantId: 't1', branchId: null }).allowed).toBe(false);
  });
  it('allows own record via own-permission', () => {
    const c = ctx({ perms: ['payslip.read_own'] });
    expect(authorizeOnEmployee(c, 'payslip.read_any', { tenantId: 't1', employeeId: 'e-self' }, { allowOwn: 'payslip.read_own' }).allowed).toBe(true);
    expect(authorizeOnEmployee(c, 'payslip.read_any', { tenantId: 't1', employeeId: 'other' }, { allowOwn: 'payslip.read_own' }).allowed).toBe(false);
  });
  it('allows team scope for managers outside listed branches', () => {
    const c = ctx({ perms: ['leave.read_team'], branchScope: { mode: 'listed', branchIds: new Set() }, teamEmployeeIds: new Set(['e9']) });
    expect(authorizeOnEmployee(c, 'leave.read_team', { tenantId: 't1', employeeId: 'e9', branchId: 'bx' }, { allowTeam: true }).allowed).toBe(true);
    expect(authorizeOnEmployee(c, 'leave.read_team', { tenantId: 't1', employeeId: 'e8', branchId: 'bx' }, { allowTeam: true })).toEqual({ allowed: false, reason: 'outside_team_scope' });
  });
});

describe('controls', () => {
  it('maker cannot be checker', () => {
    expect(differentActors('u1', 'u1')).toEqual({ allowed: false, reason: 'same_actor' });
    expect(differentActors('u1', 'u2').allowed).toBe(true);
  });
  it('critical needs MFA', () => {
    expect(requireMfaForCritical(ctx({ mfaVerified: false }), 'critical').allowed).toBe(false);
    expect(requireMfaForCritical(ctx({ mfaVerified: false }), 'sensitive').allowed).toBe(true);
  });
});

describe('field redaction', () => {
  const rec = { id: 1, full_name: 'A', date_of_birth: '1990-01-01', pan_masked: '*****1234F', monthly_ctc: 100 };
  it('strips fields without permission', () => {
    expect(redact(ctx(), 'employee', rec)).toEqual({ id: 1, full_name: 'A' });
  });
  it('owner sees own personal fields but not compensation', () => {
    expect(redact(ctx(), 'employee', rec, { isOwnRecord: true })).toEqual({ id: 1, full_name: 'A', date_of_birth: '1990-01-01', pan_masked: '*****1234F' });
  });
  it('permission reveals field', () => {
    expect(redact(ctx({ perms: ['salary.read_assignment'] }), 'employee', rec)).toHaveProperty('monthly_ctc');
  });
  it('forbiddenFields lists what filters/exports must refuse', () => {
    expect(forbiddenFields(ctx(), 'candidate')).toEqual(['current_ctc', 'expected_ctc']);
  });
  it('masks identifiers', () => {
    expect(maskIdentifier('ABCDE1234F')).toBe('******234F');
    expect(maskIdentifier('123')).toBe('***');
  });
});
