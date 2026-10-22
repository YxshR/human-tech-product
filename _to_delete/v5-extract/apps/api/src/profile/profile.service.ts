import { Inject, Injectable } from '@nestjs/common';
import {
  BankView, EmergencyContactView, IDENTIFIER_PATTERNS, IdentifierType, IdentifierView, PersonalView, ProfileChangeView, createBank, createEmergencyContact, identifierType, normaliseIdentifier,
  requestProfileChange, reviewBank, reviewProfileChange, setIdentifier, updatePersonal,
} from '@humantech/contracts';
import { authorizeOnEmployee } from '@humantech/authz';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { notify } from '../common/notify';
import { ApiError, forbidden, notFound } from '../common/errors';
import { employeeFor, tenantToday } from '../common/employee-access';
import { FieldCrypto, maskLast } from '../security/field-crypto';

export const FIELD_CRYPTO = Symbol('FIELD_CRYPTO');
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const MIN_AGE_YEARS = 14;

@Injectable()
export class ProfileService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto) {}

  // ---- personal details --------------------------------------------------------------------------------------------
  private personalView(employeeId: string, r?: Record<string, unknown>): PersonalView {
    return {
      employeeId, dateOfBirth: (r?.dob as string | null) ?? null, gender: (r?.gender as string | null) ?? null, maritalStatus: (r?.marital_status as string | null) ?? null,
      nationality: (r?.nationality as string | null) ?? null, currentAddress: (r?.current_address as Record<string, unknown>) ?? {}, permanentAddress: (r?.permanent_address as Record<string, unknown>) ?? {},
    };
  }
  private static readonly PERSONAL = `SELECT to_char(date_of_birth,'YYYY-MM-DD') AS dob, gender, marital_status, nationality, current_address, permanent_address FROM employee_personal_details WHERE tenant_id=$1 AND employee_id=$2`;

  async getPersonal(a: RequestAuth, employeeId: string): Promise<PersonalView> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.read_sensitive', { allowOwn: 'profile.read_own' });
      return this.personalView(employeeId, (await c.query(ProfileService.PERSONAL, [a.tenantId, employeeId])).rows[0]);
    });
  }
  async updatePersonal(a: RequestAuth, employeeId: string, body: unknown): Promise<PersonalView> {
    const b = updatePersonal.parse(body);
    return this.db.run(ctxOf(a, 'personal details updated'), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.update_sensitive');
      if (b.dateOfBirth) {
        const today = await tenantToday(c, a.tenantId);
        const cutoff = `${Number(today.slice(0, 4)) - MIN_AGE_YEARS}${today.slice(4)}`;
        if (b.dateOfBirth > cutoff || b.dateOfBirth < '1900-01-01') throw new ApiError('validation_failed', 422, `Date of birth must be a past date making the employee at least ${MIN_AGE_YEARS}`, [{ path: 'dateOfBirth', message: 'out of range' }]);
      }
      const cur = (await c.query(ProfileService.PERSONAL, [a.tenantId, employeeId])).rows[0];
      const v = { ...this.personalView(employeeId, cur), ...Object.fromEntries(Object.entries(b).map(([k, x]) => [k, x === null && (k.endsWith('Address')) ? {} : x])) } as PersonalView;
      await c.query(
        `INSERT INTO employee_personal_details (tenant_id, employee_id, date_of_birth, gender, marital_status, nationality, current_address, permanent_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, employee_id) DO UPDATE SET date_of_birth=EXCLUDED.date_of_birth, gender=EXCLUDED.gender, marital_status=EXCLUDED.marital_status, nationality=EXCLUDED.nationality,
            current_address=EXCLUDED.current_address, permanent_address=EXCLUDED.permanent_address`,
        [a.tenantId, employeeId, v.dateOfBirth, v.gender, v.maritalStatus, v.nationality, JSON.stringify(v.currentAddress), JSON.stringify(v.permanentAddress)]);
      await this.audit.record(c, a, 'employee.personal_update', 'employees', employeeId, null, { fields: Object.keys(b) });   // field names only
      return v;
    });
  }

  // ---- emergency contacts -------------------------------------------------------------------------------------------
  async listContacts(a: RequestAuth, employeeId: string): Promise<EmergencyContactView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.read_sensitive', { allowOwn: 'profile.read_own' });
      return (await c.query('SELECT id, name, relationship, phone FROM employee_emergency_contacts WHERE tenant_id=$1 AND employee_id=$2 ORDER BY created_at', [a.tenantId, employeeId])).rows;
    });
  }
  async addContact(a: RequestAuth, employeeId: string, body: unknown): Promise<EmergencyContactView> {
    const b = createEmergencyContact.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.update_sensitive');
      const n = (await c.query<{ n: number }>('SELECT count(*)::int n FROM employee_emergency_contacts WHERE tenant_id=$1 AND employee_id=$2', [a.tenantId, employeeId])).rows[0]!.n;
      if (n >= 5) throw new ApiError('conflict', 409, 'At most 5 emergency contacts can be recorded');
      const r = (await c.query('INSERT INTO employee_emergency_contacts (tenant_id, employee_id, name, relationship, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, relationship, phone', [a.tenantId, employeeId, b.name, b.relationship, b.phone])).rows[0]!;
      await this.audit.record(c, a, 'employee.emergency_contact_add', 'employees', employeeId, null, { contactId: r.id });
      return r;
    });
  }
  async removeContact(a: RequestAuth, employeeId: string, contactId: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.update_sensitive');
      const r = await c.query('DELETE FROM employee_emergency_contacts WHERE tenant_id=$1 AND employee_id=$2 AND id=$3', [a.tenantId, employeeId, contactId]);
      if (!r.rowCount) throw notFound('emergency contact');
      await this.audit.record(c, a, 'employee.emergency_contact_remove', 'employees', employeeId, { contactId }, null);
    });
  }

  // ---- statutory identifiers (encrypted; only masked values leave the API) -----------------------------------------
  async listIdentifiers(a: RequestAuth, employeeId: string): Promise<IdentifierView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.read_identifiers', { allowOwn: 'profile.read_own' });
      return (await c.query(`SELECT identifier_type, value_last4, verified_at FROM employee_identifiers WHERE tenant_id=$1 AND employee_id=$2 AND superseded_at IS NULL ORDER BY identifier_type`, [a.tenantId, employeeId])).rows
        .map((r) => ({ type: r.identifier_type, masked: maskLast(r.value_last4), verifiedAt: iso(r.verified_at) }));
    });
  }
  async setIdentifier(a: RequestAuth, employeeId: string, typeParam: string, body: unknown): Promise<IdentifierView> {
    const type = identifierType.safeParse(typeParam);
    if (!type.success) throw notFound('identifier type');
    const b = setIdentifier.parse(body);
    const value = normaliseIdentifier(b.value);
    const pattern = IDENTIFIER_PATTERNS[type.data];
    if (!pattern.re.test(value)) throw new ApiError('validation_failed', 422, `Invalid ${type.data.toUpperCase()}: expected ${pattern.hint}`, [{ path: 'value', message: pattern.hint }]);
    return this.db.run(ctxOf(a, 'identifier updated'), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.update_sensitive', {}, true);
      const blind = this.crypto.blindIndex(a.tenantId, type.data, value);
      const dup = await c.query('SELECT 1 FROM employee_identifiers WHERE tenant_id=$1 AND identifier_type=$2 AND blind_index=$3 AND superseded_at IS NULL AND employee_id<>$4 LIMIT 1', [a.tenantId, type.data, blind, employeeId]);
      if (dup.rowCount) throw new ApiError('conflict', 409, `This ${type.data.toUpperCase()} is already recorded for another employee`);
      await c.query('UPDATE employee_identifiers SET superseded_at=now() WHERE tenant_id=$1 AND employee_id=$2 AND identifier_type=$3 AND superseded_at IS NULL', [a.tenantId, employeeId, type.data]);
      await c.query(
        'INSERT INTO employee_identifiers (tenant_id, employee_id, identifier_type, value_ciphertext, value_last4, blind_index) VALUES ($1,$2,$3,$4,$5,$6)',
        [a.tenantId, employeeId, type.data, this.crypto.encrypt(value, `${a.tenantId}:identifier:${employeeId}:${type.data}`), value.slice(-4), blind]);
      await this.audit.record(c, a, 'employee.identifier_set', 'employees', employeeId, null, { type: type.data, last4: value.slice(-4) });
      return { type: type.data as IdentifierType, masked: maskLast(value.slice(-4)), verifiedAt: null };
    });
  }
  async verifyIdentifier(a: RequestAuth, employeeId: string, typeParam: string): Promise<IdentifierView> {
    const type = identifierType.safeParse(typeParam);
    if (!type.success) throw notFound('identifier type');
    return this.db.run(ctxOf(a, 'identifier verified'), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.verify_bank');
      const r = (await c.query(`UPDATE employee_identifiers SET verified_at=now(), verified_by=$4 WHERE tenant_id=$1 AND employee_id=$2 AND identifier_type=$3 AND superseded_at IS NULL AND verified_at IS NULL RETURNING value_last4, verified_at`, [a.tenantId, employeeId, type.data, a.userId])).rows[0];
      if (!r) throw new ApiError('invalid_state', 409, 'There is no unverified identifier of this type');
      await this.audit.record(c, a, 'employee.identifier_verify', 'employees', employeeId, null, { type: type.data });
      return { type: type.data as IdentifierType, masked: maskLast(r.value_last4), verifiedAt: iso(r.verified_at) };
    });
  }

  // ---- bank details (encrypted; maker-checker) ---------------------------------------------------------------------
  private bankView(r: Record<string, unknown>, aad: string): BankView {
    return {
      id: r.id as string, accountHolderName: r.account_holder_name as string, bankName: (r.bank_name as string | null) ?? null, accountNumberMasked: maskLast(r.account_number_last4 as string | null),
      ifsc: r.ifsc_ciphertext ? this.crypto.decrypt(r.ifsc_ciphertext as Buffer, `${aad}:ifsc`) : null, status: r.status as string, effectiveFrom: r.effective_from as string,
      effectiveTo: (r.effective_to as string | null) ?? null, createdBy: (r.created_by as string | null) ?? null, verifiedBy: (r.verified_by as string | null) ?? null,
    };
  }
  private static readonly BANK = `SELECT id, account_holder_name, bank_name, account_number_last4, ifsc_ciphertext, status, to_char(effective_from,'YYYY-MM-DD') AS effective_from,
      to_char(effective_to,'YYYY-MM-DD') AS effective_to, created_by, verified_by FROM employee_bank_details`;

  async listBank(a: RequestAuth, employeeId: string): Promise<BankView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.read_bank', { allowOwn: 'profile.read_own' });
      const aad = `${a.tenantId}:bank:${employeeId}`;
      return (await c.query(`${ProfileService.BANK} WHERE tenant_id=$1 AND employee_id=$2 ORDER BY effective_from DESC, created_at DESC LIMIT 20`, [a.tenantId, employeeId])).rows.map((r) => this.bankView(r, aad));
    });
  }
  async addBank(a: RequestAuth, employeeId: string, body: unknown): Promise<BankView> {
    const b = createBank.parse(body);
    return this.db.run(ctxOf(a, 'bank details proposed'), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.update_bank', {}, true);
      const today = await tenantToday(c, a.tenantId);
      if (b.effectiveFrom < today) throw new ApiError('validation_failed', 422, 'Bank details cannot take effect in the past', [{ path: 'effectiveFrom', message: 'must be today or later' }]);
      const live = (await c.query<{ id: string; status: string; effective_from: string }>(
        `SELECT id, status, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM employee_bank_details WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('pending_verification','verified') ORDER BY effective_from DESC LIMIT 2`, [a.tenantId, employeeId])).rows;
      if (live.some((x) => x.status === 'pending_verification')) throw new ApiError('conflict', 409, 'A bank change is already awaiting verification');
      const cur = live[0];
      if (cur) {
        if (b.effectiveFrom <= cur.effective_from) throw new ApiError('validation_failed', 422, 'The new details must start after the current ones', [{ path: 'effectiveFrom', message: `must be after ${cur.effective_from}` }]);
        await c.query(`UPDATE employee_bank_details SET effective_to = $3::date - 1 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, cur.id, b.effectiveFrom]);
      }
      const aad = `${a.tenantId}:bank:${employeeId}`;
      const r = (await c.query(
        `INSERT INTO employee_bank_details (tenant_id, employee_id, account_holder_name, account_number_ciphertext, account_number_last4, bank_name, ifsc_ciphertext, effective_from, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, account_holder_name, bank_name, account_number_last4, ifsc_ciphertext, status, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to, created_by, verified_by`,
        [a.tenantId, employeeId, b.accountHolderName, this.crypto.encrypt(b.accountNumber, `${aad}:account`), b.accountNumber.slice(-4), b.bankName ?? null, this.crypto.encrypt(b.ifsc, `${aad}:ifsc`), b.effectiveFrom, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'employee.bank_propose', 'employees', employeeId, null, { bankDetailId: r.id, last4: b.accountNumber.slice(-4), effectiveFrom: b.effectiveFrom });
      return this.bankView(r, aad);
    });
  }
  private async pendingBank(c: import('pg').PoolClient, a: RequestAuth, bankId: string): Promise<{ employee_id: string; created_by: string | null; effective_from: string }> {
    const r = (await c.query<{ employee_id: string; created_by: string | null; effective_from: string }>(
      `SELECT employee_id, created_by, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM employee_bank_details WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, bankId])).rows[0];
    if (!r) throw notFound('bank details');
    return r;
  }
  async reviewBank(a: RequestAuth, bankId: string, action: 'verify' | 'reject', body: unknown): Promise<BankView> {
    const b = reviewBank.parse(body ?? {});
    return this.db.run(ctxOf(a, `bank details ${action}`), async (c) => {
      const row = await this.pendingBank(c, a, bankId);
      await employeeFor(c, a, row.employee_id, 'employee.verify_bank');
      const status = (await c.query<{ status: string }>('SELECT status FROM employee_bank_details WHERE tenant_id=$1 AND id=$2', [a.tenantId, bankId])).rows[0]!.status;
      if (row.created_by === a.userId) throw new ApiError('maker_checker_violation', 403, 'You cannot verify bank details you entered');
      if (status !== 'pending_verification') throw new ApiError('invalid_state', 409, `These bank details are already ${status}`);
      if (action === 'verify') {
        await c.query(`UPDATE employee_bank_details SET status='verified', verified_by=$3, verified_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, bankId, a.userId]);
      } else await this.rejectBank(c, a, bankId, row);
      await this.audit.record(c, a, `employee.bank_${action}`, 'employees', row.employee_id, null, { bankDetailId: bankId }, b.comment);
      await notify(c, { tenantId: a.tenantId, userIds: [row.created_by], eventKey: `bank.${action === 'verify' ? 'verified' : 'rejected'}`, dedupeKey: `bank-review:${bankId}`,
        title: `The bank details you entered were ${action === 'verify' ? 'verified' : 'rejected'}`, body: b.comment, data: { bankDetailId: bankId, employeeId: row.employee_id } });
      return this.bankById(c, a, bankId, row.employee_id);
    });
  }
  private async rejectBank(c: import('pg').PoolClient, a: RequestAuth, bankId: string, row: { employee_id: string; effective_from: string }): Promise<void> {
    await c.query(`UPDATE employee_bank_details SET status='rejected' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, bankId]);
    // The details it was going to replace stay in force.
    await c.query(`UPDATE employee_bank_details SET effective_to=NULL WHERE tenant_id=$1 AND employee_id=$2 AND status='verified' AND effective_to = $3::date - 1`, [a.tenantId, row.employee_id, row.effective_from]);
  }
  async withdrawBank(a: RequestAuth, bankId: string): Promise<BankView> {
    return this.db.run(ctxOf(a, 'bank details withdrawn'), async (c) => {
      const row = await this.pendingBank(c, a, bankId);
      await employeeFor(c, a, row.employee_id, 'employee.update_bank');
      const status = (await c.query<{ status: string }>('SELECT status FROM employee_bank_details WHERE tenant_id=$1 AND id=$2', [a.tenantId, bankId])).rows[0]!.status;
      if (row.created_by !== a.userId) throw forbidden('Only the person who entered these details can withdraw them');
      if (status !== 'pending_verification') throw new ApiError('invalid_state', 409, `These bank details are already ${status}`);
      await this.rejectBank(c, a, bankId, row);
      await this.audit.record(c, a, 'employee.bank_withdraw', 'employees', row.employee_id, null, { bankDetailId: bankId });
      return this.bankById(c, a, bankId, row.employee_id);
    });
  }
  private async bankById(c: import('pg').PoolClient, a: RequestAuth, bankId: string, employeeId: string): Promise<BankView> {
    return this.bankView((await c.query(`${ProfileService.BANK} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, bankId])).rows[0]!, `${a.tenantId}:bank:${employeeId}`);
  }

  // ---- profile change requests (employee asks, HR decides) ---------------------------------------------------------------
  private static readonly PCR = `SELECT r.id, r.employee_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, e.branch_id, r.requested_changes, r.status, r.requested_by, r.reviewed_by, r.review_comment, r.created_at
      FROM profile_change_requests r JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id`;
  private pcrView = (r: Record<string, unknown>): ProfileChangeView => ({
    id: r.id as string, employeeId: r.employee_id as string, employeeName: r.name as string, changes: r.requested_changes as Record<string, unknown>, status: r.status as string,
    requestedBy: (r.requested_by as string | null) ?? null, reviewedBy: (r.reviewed_by as string | null) ?? null, reviewComment: (r.review_comment as string | null) ?? null, createdAt: (r.created_at as Date).toISOString(),
  });
  async requestChange(a: RequestAuth, body: unknown): Promise<ProfileChangeView> {
    const b = requestProfileChange.parse(body);
    if (!a.employeeId) throw new ApiError('validation_failed', 422, 'Your login is not linked to an employee profile');
    return this.db.run(ctxOf(a), async (c) => {
      const open = await c.query(`SELECT 1 FROM profile_change_requests WHERE tenant_id=$1 AND employee_id=$2 AND status='pending'`, [a.tenantId, a.employeeId]);
      if (open.rowCount) throw new ApiError('conflict', 409, 'You already have a change request awaiting review');
      const r = (await c.query<{ id: string }>('INSERT INTO profile_change_requests (tenant_id, employee_id, requested_changes, requested_by) VALUES ($1,$2,$3,$4) RETURNING id', [a.tenantId, a.employeeId, JSON.stringify(b.changes), a.userId])).rows[0]!;
      await this.audit.record(c, a, 'profile_change.request', 'profile_change_requests', r.id, null, { fields: Object.keys(b.changes) });
      return this.pcrView((await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, r.id])).rows[0]!);
    });
  }
  async listChanges(a: RequestAuth, status?: string): Promise<ProfileChangeView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const rows = (await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT 100`, [a.tenantId, status ?? null])).rows;
      return rows.filter((r) => r.employee_id === a.employeeId
        || authorizeOnEmployee(a, 'profile.review_change', { tenantId: a.tenantId, branchId: r.branch_id, employeeId: r.employee_id }).allowed).map(this.pcrView);
    });
  }
  async reviewChange(a: RequestAuth, id: string, action: 'approve' | 'reject', body: unknown): Promise<ProfileChangeView> {
    const b = reviewProfileChange.parse(body ?? {});
    return this.db.run(ctxOf(a, `profile change ${action}`), async (c) => {
      const r = (await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound('change request');
      const d = authorizeOnEmployee(a, 'profile.review_change', { tenantId: a.tenantId, branchId: r.branch_id, employeeId: r.employee_id });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('change request');
      if (r.requested_by === a.userId) throw new ApiError('maker_checker_violation', 403, 'You cannot review your own change request');
      if (r.status !== 'pending') throw new ApiError('invalid_state', 409, `This request is already ${r.status}`);
      if (action === 'approve') await this.applyChanges(c, a, r.employee_id, r.requested_changes);
      await c.query(`UPDATE profile_change_requests SET status=$3, reviewed_by=$4, reviewed_at=now(), review_comment=$5 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, action === 'approve' ? 'approved' : 'rejected', a.userId, b.comment ?? null]);
      await this.audit.record(c, a, `profile_change.${action}`, 'profile_change_requests', id, null, { fields: Object.keys(r.requested_changes) }, b.comment);
      await notify(c, { tenantId: a.tenantId, userIds: [r.requested_by], eventKey: `profile_change.${action === 'approve' ? 'approved' : 'rejected'}`, dedupeKey: `profile-change:${id}`,
        title: `Your profile change request was ${action === 'approve' ? 'approved' : 'rejected'}`, body: b.comment, data: { profileChangeId: id } });
      return this.pcrView((await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }
  async cancelChange(a: RequestAuth, id: string): Promise<ProfileChangeView> {
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`, [a.tenantId, id])).rows[0];
      if (!r || r.requested_by !== a.userId) throw notFound('change request');
      if (r.status !== 'pending') throw new ApiError('invalid_state', 409, `This request is already ${r.status}`);
      await c.query(`UPDATE profile_change_requests SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await this.audit.record(c, a, 'profile_change.cancel', 'profile_change_requests', id, null, null);
      return this.pcrView((await c.query(`${ProfileService.PCR} WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }
  private async applyChanges(c: import('pg').PoolClient, a: RequestAuth, employeeId: string, ch: Record<string, unknown>): Promise<void> {
    if (ch.phone !== undefined || ch.personalEmail !== undefined) {
      await c.query('UPDATE employees SET phone=COALESCE($3,phone), personal_email=COALESCE($4,personal_email) WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId, (ch.phone as string | undefined) ?? null, (ch.personalEmail as string | undefined) ?? null]);
    }
    if (ch.maritalStatus !== undefined || ch.currentAddress !== undefined || ch.permanentAddress !== undefined) {
      await c.query(
        `INSERT INTO employee_personal_details (tenant_id, employee_id, marital_status, current_address, permanent_address) VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),COALESCE($5::jsonb,'{}'::jsonb))
         ON CONFLICT (tenant_id, employee_id) DO UPDATE SET marital_status=COALESCE($3, employee_personal_details.marital_status),
            current_address=COALESCE($4::jsonb, employee_personal_details.current_address), permanent_address=COALESCE($5::jsonb, employee_personal_details.permanent_address)`,
        [a.tenantId, employeeId, (ch.maritalStatus as string | undefined) ?? null, ch.currentAddress ? JSON.stringify(ch.currentAddress) : null, ch.permanentAddress ? JSON.stringify(ch.permanentAddress) : null]);
    }
  }
}
