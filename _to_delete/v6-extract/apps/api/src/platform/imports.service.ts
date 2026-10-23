import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hasPermission, inBranchScope } from '@humantech/authz';
import { IMPORT_COLUMNS, ImportType, ImportView, candidateImportRow, employeeImportRow, importQuery } from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { CsvError, parseCsv, toCsv } from '../common/csv';
import { ApiError, forbidden, notFound } from '../common/errors';
import { DocumentsService } from '../files/documents.service';

const MAX_ROWS = 2000;
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const invalid = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);
const normalisePhone = (p: string): string => p.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
type Row = Record<string, unknown>;
interface Parsed { rowNumber: number; raw: Record<string, string>; data: Row | null; errors: string[]; keys: { email: string | null; phone: string | null; workEmail?: string | null } }

const PERMS: Record<ImportType, { create: 'employee.create' | 'candidate.create' }> = { employees: { create: 'employee.create' }, candidates: { create: 'candidate.create' } };

@Injectable()
export class ImportsService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(DocumentsService) private readonly files: DocumentsService) {}

  private view(r: Row, errors: Array<{ row: number; messages: string[] }>): ImportView {
    const sum = (r.error_summary ?? {}) as { skipped?: number };
    return {
      id: r.id as string, importType: r.import_type as string, status: r.status as string, totalRows: (r.total_rows as number | null) ?? null, acceptedRows: (r.accepted_rows as number | null) ?? null,
      rejectedRows: (r.rejected_rows as number | null) ?? null, skippedRows: sum.skipped ?? 0, duplicatePolicy: r.duplicate_policy as string,
      createdAt: (r.created_at as Date).toISOString(), completedAt: r.completed_at ? (r.completed_at as Date).toISOString() : null, errors, hasResult: r.result_file_id !== null,
    };
  }
  private async errorsFor(c: PoolClient, a: RequestAuth, id: string): Promise<Array<{ row: number; messages: string[] }>> {
    return (await c.query<{ row_number: number; errors: string[] }>(
      `SELECT row_number, errors FROM import_rows WHERE tenant_id=$1 AND import_job_id=$2 AND status IN ('invalid','duplicate') ORDER BY row_number LIMIT 100`, [a.tenantId, id]))
      .rows.map((r) => ({ row: r.row_number, messages: r.errors }));
  }
  private async load(c: PoolClient, a: RequestAuth, id: string, lock = false): Promise<Row> {
    const r = (await c.query(`SELECT * FROM import_jobs WHERE tenant_id=$1 AND id=$2 AND created_by=$3${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id, a.userId])).rows[0];
    if (!r) throw notFound('import');
    return r;
  }

  /** Step 1: parse and check every row. Nothing is created yet. */
  async create(a: RequestAuth, type: string, query: unknown, body: unknown): Promise<ImportView> {
    if (type !== 'employees' && type !== 'candidates') throw notFound('import type');
    if (!hasPermission(a, PERMS[type].create)) throw forbidden();
    const q = importQuery.parse(query);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiError('unsupported_media_type', 415, 'Send the CSV file as the request body with Content-Type: text/csv');
    let table: string[][];
    try { table = parseCsv(body.toString('utf8'), { maxRows: MAX_ROWS }); } catch (e) {
      if (e instanceof CsvError) throw invalid('file', `The CSV file could not be read: ${e.message}`);
      throw e;
    }
    if (table.length < 2) throw invalid('file', 'The file needs a header row and at least one data row');
    const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const spec = IMPORT_COLUMNS[type]; const known = new Set([...spec.required, ...spec.optional]);
    const unknown = header.filter((h) => !known.has(h)); const missing = spec.required.filter((h) => !header.includes(h));
    const dupHeader = header.filter((h, i) => header.indexOf(h) !== i);
    if (unknown.length || missing.length || dupHeader.length) {
      throw new ApiError('validation_failed', 422, 'The header row does not match this import', [
        ...unknown.map((h) => ({ path: 'header', message: `unknown column "${h}"` })), ...missing.map((h) => ({ path: 'header', message: `missing column "${h}"` })),
        ...dupHeader.map((h) => ({ path: 'header', message: `column "${h}" appears twice` })),
      ]);
    }

    return this.db.run(ctxOf(a, `${type} import validated`), async (c) => {
      const parsed = type === 'employees' ? await this.checkEmployees(c, a, header, table.slice(1)) : this.checkCandidates(header, table.slice(1));
      await this.markDuplicates(c, a, type, parsed, q.duplicatePolicy);
      const accepted = parsed.filter((p) => p.errors.length === 0 && p.data).length;
      const skipped = parsed.filter((p) => p.errors.length === 0 && !p.data).length;
      const rejected = parsed.length - accepted - skipped;
      const filename = q.filename ?? `${type}-import.csv`;
      const sourceId = await this.files.storeGenerated(c, a, 'import_source', filename, 'text/csv; charset=utf-8', body);
      const job = (await c.query(
        `INSERT INTO import_jobs (tenant_id, import_type, status, source_file_id, source_checksum_sha256, total_rows, accepted_rows, rejected_rows, duplicate_policy, created_by, error_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [a.tenantId, type, accepted > 0 ? 'needs_confirmation' : 'failed', sourceId, createHash('sha256').update(body).digest('hex'), parsed.length, accepted, rejected, q.duplicatePolicy, a.userId, JSON.stringify({ skipped })])).rows[0]!;
      for (const p of parsed) {
        const status = p.errors.length ? (p.errors.some((m) => m.startsWith('duplicate')) ? 'duplicate' : 'invalid') : p.data ? 'valid' : 'skipped';
        await c.query(`INSERT INTO import_rows (tenant_id, import_job_id, row_number, status, raw, errors) VALUES ($1,$2,$3,$4,$5,$6)`,
          [a.tenantId, job.id, p.rowNumber, status, JSON.stringify(p.raw), JSON.stringify(p.errors)]);
      }
      await this.audit.record(c, a, 'import.validate', 'import_jobs', job.id, null, { type, rows: parsed.length, accepted, rejected, skipped });
      return this.view(job, await this.errorsFor(c, a, job.id));
    });
  }

  private rawRow(header: string[], cells: string[]): Record<string, string> {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h] = (cells[i] ?? '').trim(); });
    return raw;
  }
  private messages(e: { issues: Array<{ path: Array<string | number>; message: string }> }): string[] { return e.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`); }

  private async checkEmployees(c: PoolClient, a: RequestAuth, header: string[], rows: string[][]): Promise<Parsed[]> {
    const branches = new Map((await c.query<{ id: string; code: string }>('SELECT id, upper(code) AS code FROM branches WHERE tenant_id=$1', [a.tenantId])).rows.map((r) => [r.code, r.id]));
    const depts = new Map((await c.query<{ id: string; code: string }>('SELECT id, upper(code) AS code FROM departments WHERE tenant_id=$1', [a.tenantId])).rows.map((r) => [r.code, r.id]));
    return rows.map((cells, i) => {
      const raw = this.rawRow(header, cells); const errors: string[] = [];
      const r = employeeImportRow.safeParse(raw);
      if (!r.success) return { rowNumber: i + 2, raw, data: null, errors: this.messages(r.error), keys: { email: null, phone: null } };
      const d = r.data;
      const branchId = branches.get(d.branch_code.toUpperCase());
      if (!branchId || !inBranchScope(a, { tenantId: a.tenantId, branchId }).allowed) errors.push(`branch_code: unknown branch "${d.branch_code}"`);
      const deptId = d.department_code ? depts.get(d.department_code.toUpperCase()) : undefined;
      if (d.department_code && !deptId) errors.push(`department_code: unknown department "${d.department_code}"`);
      if ((d.personal_email || d.phone) && !hasPermission(a, 'employee.update_sensitive')) errors.push('personal_email/phone: you cannot set personal contact details');
      return {
        rowNumber: i + 2, raw, errors, keys: { email: null, phone: null, workEmail: d.work_email ?? null },
        data: errors.length ? null : { ...d, branchId, departmentId: deptId ?? null, employmentType: d.employment_type ?? 'full_time' },
      };
    });
  }
  private checkCandidates(header: string[], rows: string[][]): Parsed[] {
    return rows.map((cells, i) => {
      const raw = this.rawRow(header, cells);
      const r = candidateImportRow.safeParse(raw);
      if (!r.success) return { rowNumber: i + 2, raw, data: null, errors: this.messages(r.error), keys: { email: null, phone: null } };
      const phone = r.data.phone ? normalisePhone(r.data.phone) : null;
      if (phone !== null && !/^\+?[0-9]{6,15}$/.test(phone)) return { rowNumber: i + 2, raw, data: null, errors: ['phone: expected 6 to 15 digits'], keys: { email: null, phone: null } };
      return { rowNumber: i + 2, raw, errors: [], data: { ...r.data, phone }, keys: { email: r.data.email ?? null, phone } };
    });
  }

  /** Duplicates inside the file and against existing records. `reject` makes them errors, `skip` quietly leaves them out. */
  private async markDuplicates(c: PoolClient, a: RequestAuth, type: ImportType, rows: Parsed[], policy: 'reject' | 'skip'): Promise<void> {
    const live = rows.filter((r) => r.data);
    let existing: Set<string>;
    if (type === 'employees') {
      const emails = live.map((r) => r.keys.workEmail).filter((e): e is string => !!e);
      existing = new Set(emails.length ? (await c.query<{ e: string }>('SELECT lower(work_email) AS e FROM employees WHERE tenant_id=$1 AND lower(work_email) = ANY($2::text[])', [a.tenantId, emails])).rows.map((r) => r.e) : []);
    } else {
      const emails = live.map((r) => r.keys.email).filter((e): e is string => !!e); const phones = live.map((r) => r.keys.phone).filter((e): e is string => !!e);
      const found = (await c.query<{ email: string | null; phone: string | null }>(
        'SELECT email_normalized AS email, phone_normalized AS phone FROM candidates WHERE tenant_id=$1 AND archived_at IS NULL AND (email_normalized = ANY($2::text[]) OR phone_normalized = ANY($3::text[]))', [a.tenantId, emails, phones])).rows;
      existing = new Set(found.flatMap((r) => [r.email && `e:${r.email}`, r.phone && `p:${r.phone}`].filter((x): x is string => !!x)));
    }
    const seen = new Set<string>();
    for (const r of live) {
      const ids = type === 'employees' ? (r.keys.workEmail ? [`w:${r.keys.workEmail}`] : []) : [r.keys.email && `e:${r.keys.email}`, r.keys.phone && `p:${r.keys.phone}`].filter((x): x is string => !!x);
      const inDb = ids.some((k) => existing.has(type === 'employees' ? k.slice(2) : k));
      const inFile = ids.some((k) => seen.has(k));
      ids.forEach((k) => seen.add(k));
      if (inDb || inFile) {
        r.data = policy === 'skip' ? null : r.data;
        if (policy === 'reject') { r.errors.push(`duplicate: ${inDb ? 'already exists' : 'repeated earlier in this file'}`); r.data = null; }
      }
    }
  }

  async get(a: RequestAuth, id: string): Promise<ImportView> {
    return this.db.run(ctxOf(a), async (c) => { const j = await this.load(c, a, id); return this.view(j, await this.errorsFor(c, a, id)); });
  }
  async list(a: RequestAuth): Promise<ImportView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query('SELECT * FROM import_jobs WHERE tenant_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT 50', [a.tenantId, a.userId])).rows.map((r) => this.view(r, [])));
  }
  async cancel(a: RequestAuth, id: string): Promise<ImportView> {
    return this.db.run(ctxOf(a), async (c) => {
      const j = await this.load(c, a, id, true);
      if (j.status !== 'needs_confirmation') throw new ApiError('invalid_state', 409, `A ${j.status} import cannot be cancelled`);
      const r = (await c.query(`UPDATE import_jobs SET status='cancelled', completed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [a.tenantId, id])).rows[0]!;
      await this.audit.record(c, a, 'import.cancel', 'import_jobs', id, null, null);
      return this.view(r, []);
    });
  }
  async resultLink(a: RequestAuth, id: string): Promise<{ url: string; expiresAt: string }> {
    return this.db.run(ctxOf(a), async (c) => {
      const j = await this.load(c, a, id);
      if (!j.result_file_id) throw new ApiError('invalid_state', 409, 'This import has no result file yet');
      return this.files.issueLink(c, a, j.result_file_id as string);
    });
  }

  /** Step 2: create the records. Each row is its own savepoint, so one bad row never loses the others. */
  async commit(a: RequestAuth, id: string): Promise<ImportView> {
    return this.db.run(ctxOf(a, 'import committed'), async (c) => {
      const j = await this.load(c, a, id, true);
      if (!hasPermission(a, 'import.commit')) throw forbidden();
      if (j.status !== 'needs_confirmation') throw new ApiError('invalid_state', 409, `This import is ${j.status}, not waiting for confirmation`);
      const type = j.import_type as ImportType;
      if (!hasPermission(a, PERMS[type].create)) throw forbidden();
      const rows = (await c.query<{ id: string; row_number: number; raw: Record<string, string> }>(
        `SELECT id, row_number, raw FROM import_rows WHERE tenant_id=$1 AND import_job_id=$2 AND status='valid' ORDER BY row_number`, [a.tenantId, id])).rows;
      const header = Object.keys(rows[0]?.raw ?? {});
      const reparsed = type === 'employees' ? await this.checkEmployees(c, a, header, rows.map((r) => header.map((h) => r.raw[h] ?? ''))) : this.checkCandidates(header, rows.map((r) => header.map((h) => r.raw[h] ?? '')));
      await this.markDuplicates(c, a, type, reparsed, j.duplicate_policy as 'reject' | 'skip');   // the world may have changed since validation
      const report: Array<[number, string, string, string]> = [];
      let committed = 0; let failed = 0; let skipped = 0;
      for (const [i, row] of rows.entries()) {
        const p = reparsed[i]!;
        if (p.errors.length || !p.data) {
          const dup = p.errors.some((m) => m.startsWith('duplicate'));
          if (!p.errors.length) skipped++; else failed++;
          await c.query(`UPDATE import_rows SET status=$3, errors=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, row.id, p.errors.length ? (dup ? 'duplicate' : 'invalid') : 'skipped', JSON.stringify(p.errors)]);
          report.push([row.row_number, p.errors.length ? 'rejected' : 'skipped', '', p.errors.join('; ') || 'duplicate skipped']);
          continue;
        }
        await c.query('SAVEPOINT import_row');
        try {
          const entityId = type === 'employees' ? await this.insertEmployee(c, a, p.data) : await this.insertCandidate(c, a, p.data);
          await c.query('RELEASE SAVEPOINT import_row');
          await c.query(`UPDATE import_rows SET status='committed', committed_entity_id=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, row.id, entityId]);
          report.push([row.row_number, 'created', entityId, '']); committed++;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT import_row');
          failed++;
          const msg = (e as { code?: string }).code === '23505' ? 'duplicate: already exists' : 'could not be saved';
          await c.query(`UPDATE import_rows SET status='invalid', errors=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, row.id, JSON.stringify([msg])]);
          report.push([row.row_number, 'rejected', '', msg]);
        }
      }
      const preRejected = (j.rejected_rows as number) ?? 0;
      const resultCsv = Buffer.from(toCsv(['row', 'outcome', 'record_id', 'note'], report), 'utf8');
      const resultId = await this.files.storeGenerated(c, a, 'import_result', `${type}-import-result.csv`, 'text/csv; charset=utf-8', resultCsv);
      const r = (await c.query(
        `UPDATE import_jobs SET status=$3, accepted_rows=$4, rejected_rows=$5, result_file_id=$6, completed_at=now(), error_summary=$7 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [a.tenantId, id, failed + preRejected > 0 ? 'completed_with_errors' : 'completed', committed, preRejected + failed, resultId,
          JSON.stringify({ skipped: skipped + (((j.error_summary ?? {}) as { skipped?: number }).skipped ?? 0) })])).rows[0]!;
      await this.audit.record(c, a, 'import.commit', 'import_jobs', id, { status: 'needs_confirmation' }, { type, created: committed, failed, skipped });
      return this.view(r, await this.errorsFor(c, a, id));
    });
  }

  private async insertEmployee(c: PoolClient, a: RequestAuth, d: Row): Promise<string> {
    const num = (await c.query<{ n: string }>('SELECT app.next_employee_number() AS n')).rows[0]!.n;
    return (await c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, work_email, personal_email, phone, branch_id, department_id, employment_type, joined_at, created_by, employment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'onboarding') RETURNING id`,
      [a.tenantId, num, d.first_name, d.last_name ?? null, d.work_email ?? null, d.personal_email ?? null, d.phone ?? null, d.branchId, d.departmentId, d.employmentType, d.joined_at, a.userId])).rows[0]!.id;
  }
  private async insertCandidate(c: PoolClient, a: RequestAuth, d: Row): Promise<string> {
    const code = (await c.query<{ n: string }>(`SELECT app.next_number('candidate','CAN-',5::smallint) AS n`)).rows[0]!.n;
    return (await c.query<{ id: string }>(
      `INSERT INTO candidates (tenant_id, candidate_code, first_name, last_name, email_normalized, phone_normalized, city, source, role_title, total_experience_months, notice_period_days, recruiter_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [a.tenantId, code, d.first_name, d.last_name ?? null, d.email ?? null, d.phone ?? null, d.city ?? null, d.source ?? null, d.role_title ?? null, d.total_experience_months ?? null, d.notice_period_days ?? null, a.userId])).rows[0]!.id;
  }
}
