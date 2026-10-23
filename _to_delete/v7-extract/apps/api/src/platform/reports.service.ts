import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PermissionKey, hasPermission, inBranchScope } from '@humantech/authz';
import { ExportView, REPORT_KEYS, ReportFilters, ReportKey, ReportResult, createExport, reportFilters, reportQuery } from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { toCsv } from '../common/csv';
import { tenantToday } from '../common/employee-access';
import { ApiError, forbidden, notFound } from '../common/errors';
import { DocumentsService } from '../files/documents.service';

const ROW_CAP = 10_000;
const EXPORT_TTL_MS = 24 * 3600_000;
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
type Row = Record<string, string | number | null>;
interface Def {
  title: string;
  /** All of these are required (the route guard only checks any-of). */
  needs: PermissionKey[];
  /** Extra permission needed to EXPORT (not to view) the report. */
  exportNeeds?: PermissionKey[];
  run: (c: PoolClient, a: RequestAuth, f: ReportFilters, o: { sensitive: boolean }) => Promise<{ columns: Array<{ key: string; label: string }>; rows: Row[] }>;
}
const col = (key: string, label: string) => ({ key, label });
const invalid = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);

/** Branch scope applies to every people report: a branch manager's report never contains another branch. */
function scoped(a: RequestAuth, f: ReportFilters, alias: string, params: unknown[]): string {
  let sql = '';
  if (f.branchId) {
    if (!inBranchScope(a, { tenantId: a.tenantId, branchId: f.branchId }).allowed) throw notFound('branch');
    params.push(f.branchId); sql += ` AND ${alias}.branch_id=$${params.length}`;
  }
  if (a.branchScope.mode === 'listed') { params.push([...a.branchScope.branchIds]); sql += ` AND ${alias}.branch_id = ANY($${params.length}::uuid[])`; }
  return sql;
}

const DEFS: Record<ReportKey, Def> = {
  headcount: {
    title: 'Headcount', needs: ['report.read', 'employee.read'],
    async run(c, a, f) {
      const params: unknown[] = [a.tenantId]; let w = scoped(a, f, 'e', params);
      if (f.status) { params.push(f.status); w += ` AND e.employment_status=$${params.length}`; }
      const rows = (await c.query(
        `SELECT COALESCE(b.name,'(no branch)') AS branch, COALESCE(d.name,'(no department)') AS department, e.employment_status AS status, count(*)::int AS employees
           FROM employees e LEFT JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
          WHERE e.tenant_id=$1 AND e.employment_status <> 'archived' ${w} GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT ${ROW_CAP + 1}`, params)).rows;
      return { columns: [col('branch', 'Branch'), col('department', 'Department'), col('status', 'Status'), col('employees', 'Employees')], rows };
    },
  },
  employees: {
    title: 'Employee list', needs: ['report.read', 'employee.read'], exportNeeds: ['employee.export'],
    async run(c, a, f, o) {
      const params: unknown[] = [a.tenantId]; let w = scoped(a, f, 'e', params);
      if (f.status) { params.push(f.status); w += ` AND e.employment_status=$${params.length}`; }
      const sensitive = o.sensitive && hasPermission(a, 'employee.read_sensitive');
      const rows = (await c.query(
        `SELECT e.employee_number AS "employeeNumber", trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, e.work_email AS "workEmail", e.employment_status AS status,
                e.employment_type AS "employmentType", b.name AS branch, d.name AS department, to_char(e.joined_at,'YYYY-MM-DD') AS "joinedAt"
                ${sensitive ? ', e.personal_email AS "personalEmail", e.phone AS phone' : ''}
           FROM employees e LEFT JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
          WHERE e.tenant_id=$1 AND e.employment_status <> 'archived' ${w} ORDER BY e.employee_number LIMIT ${ROW_CAP + 1}`, params)).rows;
      const columns = [col('employeeNumber', 'Employee no.'), col('name', 'Name'), col('workEmail', 'Work email'), col('status', 'Status'), col('employmentType', 'Type'), col('branch', 'Branch'), col('department', 'Department'), col('joinedAt', 'Joined')];
      if (sensitive) columns.push(col('personalEmail', 'Personal email'), col('phone', 'Phone'));
      return { columns, rows };
    },
  },
  attendance_summary: {
    title: 'Attendance summary', needs: ['report.read', 'attendance.read'],
    async run(c, a, f) {
      if (!f.from || !f.to) throw invalid('from', 'from and to are required for this report');
      if (f.to < f.from) throw invalid('to', 'to cannot be before from');
      if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > 366) throw invalid('to', 'choose a range of at most 366 days');
      const params: unknown[] = [a.tenantId, f.from, f.to]; const w = scoped(a, f, 'e', params);
      const rows = (await c.query(
        `SELECT e.employee_number AS "employeeNumber", trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name,
                count(*) FILTER (WHERE x.attendance_status='present')::int AS present, count(*) FILTER (WHERE x.attendance_status='work_from_home')::int AS "workFromHome",
                count(*) FILTER (WHERE x.attendance_status='half_day')::int AS "halfDay", count(*) FILTER (WHERE x.attendance_status='absent')::int AS absent,
                count(*) FILTER (WHERE x.attendance_status='leave')::int AS leave, count(*) FILTER (WHERE x.attendance_status='holiday')::int AS holiday,
                count(*) FILTER (WHERE x.attendance_status='weekly_off')::int AS "weeklyOff", count(*) FILTER (WHERE x.attendance_status='not_marked')::int AS "notMarked",
                COALESCE(sum(x.late_minutes),0)::int AS "lateMinutes"
           FROM employees e JOIN attendance_days x ON x.tenant_id=e.tenant_id AND x.employee_id=e.id AND x.work_date BETWEEN $2::date AND $3::date
          WHERE e.tenant_id=$1 ${w} GROUP BY e.id, e.employee_number, e.first_name, e.last_name ORDER BY e.employee_number LIMIT ${ROW_CAP + 1}`, params)).rows;
      return { columns: [col('employeeNumber', 'Employee no.'), col('name', 'Name'), col('present', 'Present'), col('workFromHome', 'Work from home'), col('halfDay', 'Half day'), col('absent', 'Absent'),
        col('leave', 'Leave'), col('holiday', 'Holiday'), col('weeklyOff', 'Weekly off'), col('notMarked', 'Not marked'), col('lateMinutes', 'Late minutes')], rows };
    },
  },
  leave_balances: {
    title: 'Leave balances', needs: ['report.read', 'leave.read_all'],
    async run(c, a, f) {
      const asOf = f.asOf ?? (await tenantToday(c, a.tenantId));
      const params: unknown[] = [a.tenantId, asOf]; const w = scoped(a, f, 'e', params);
      const rows = (await c.query(
        `SELECT e.employee_number AS "employeeNumber", trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, t.code AS "leaveType", t.name AS "leaveTypeName", sum(l.days_delta)::text AS balance
           FROM leave_balance_transactions l JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id JOIN leave_types t ON t.tenant_id=l.tenant_id AND t.id=l.leave_type_id
          WHERE l.tenant_id=$1 AND l.effective_date <= $2::date AND e.employment_status <> 'archived' ${w}
          GROUP BY e.employee_number, e.first_name, e.last_name, t.code, t.name ORDER BY e.employee_number, t.code LIMIT ${ROW_CAP + 1}`, params)).rows;
      return { columns: [col('employeeNumber', 'Employee no.'), col('name', 'Name'), col('leaveType', 'Leave type'), col('leaveTypeName', 'Leave type name'), col('balance', `Balance (days) as of ${asOf}`)], rows };
    },
  },
  hiring_funnel: {
    title: 'Hiring funnel', needs: ['report.read', 'candidate.read'],
    async run(c, a, f) {
      const params: unknown[] = [a.tenantId]; let w = '';
      if (f.from) { params.push(f.from); w += ` AND k.created_at >= ($${params.length}::date AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`; }
      if (f.to) { params.push(f.to); w += ` AND k.created_at < (($${params.length}::date + 1) AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`; }
      const counts = new Map((await c.query<{ stage: string; n: number }>(`SELECT k.current_stage AS stage, count(*)::int AS n FROM candidates k WHERE k.tenant_id=$1 AND k.archived_at IS NULL ${w} GROUP BY 1`, params)).rows.map((r) => [r.stage, r.n]));
      const order = ['lead_new', 'contacted', 'screening', 'submitted_to_client', 'interview', 'selected_offer', 'joined', 'on_hold', 'rejected', 'withdrawn'];
      return { columns: [col('stage', 'Stage'), col('candidates', 'Candidates')], rows: order.map((s) => ({ stage: s, candidates: counts.get(s) ?? 0 })) };
    },
  },
  candidates: {
    title: 'Candidates', needs: ['candidate.read'], exportNeeds: ['candidate.export'],
    async run(c, a, f) {
      const params: unknown[] = [a.tenantId]; let w = '';
      if (f.status) { params.push(f.status); w += ` AND k.current_stage=$${params.length}`; }
      if (f.from) { params.push(f.from); w += ` AND k.created_at >= ($${params.length}::date AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`; }
      if (f.to) { params.push(f.to); w += ` AND k.created_at < (($${params.length}::date + 1) AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`; }
      const rows = (await c.query(
        `SELECT k.candidate_code AS "candidateCode", trim(k.first_name || ' ' || COALESCE(k.last_name,'')) AS name, k.email_normalized AS email, k.phone_normalized AS phone, k.current_stage AS stage,
                k.source, k.role_title AS role, u.display_name AS recruiter, to_char(k.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS "createdOn"
           FROM candidates k LEFT JOIN users u ON u.id=k.recruiter_user_id WHERE k.tenant_id=$1 AND k.archived_at IS NULL ${w} ORDER BY k.candidate_code LIMIT ${ROW_CAP + 1}`, params)).rows;
      return { columns: [col('candidateCode', 'Candidate'), col('name', 'Name'), col('email', 'Email'), col('phone', 'Phone'), col('stage', 'Stage'), col('source', 'Source'), col('role', 'Role'), col('recruiter', 'Recruiter'), col('createdOn', 'Created')], rows };
    },
  },
};

const exportView = (r: Record<string, unknown>): ExportView => ({
  id: r.id as string, reportKey: r.report_key as string, format: r.format as string, status: r.status as string, rowCount: (r.row_count as number | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(), expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : null,
});

@Injectable()
export class ReportsService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(DocumentsService) private readonly files: DocumentsService) {}

  catalogue(a: RequestAuth): Array<{ key: ReportKey; title: string; canExport: boolean }> {
    return REPORT_KEYS.filter((k) => DEFS[k].needs.every((p) => hasPermission(a, p)))
      .map((k) => ({ key: k, title: DEFS[k].title, canExport: hasPermission(a, 'export.create') && (DEFS[k].exportNeeds ?? []).every((p) => hasPermission(a, p)) }));
  }

  private async execute(c: PoolClient, a: RequestAuth, key: ReportKey, f: ReportFilters, forExport: boolean): Promise<ReportResult> {
    const def = DEFS[key];
    if (!def.needs.every((p) => hasPermission(a, p))) throw forbidden();
    if (forExport && !(hasPermission(a, 'export.create') && (def.exportNeeds ?? []).every((p) => hasPermission(a, p)))) throw forbidden('You cannot export this report');
    const r = await def.run(c, a, f, { sensitive: forExport && hasPermission(a, 'export.sensitive') });
    const truncated = r.rows.length > ROW_CAP;
    return { key, title: def.title, columns: r.columns, rows: truncated ? r.rows.slice(0, ROW_CAP) : r.rows, truncated };
  }

  async run(a: RequestAuth, key: string, query: unknown): Promise<{ result: ReportResult; csv?: string }> {
    if (!(REPORT_KEYS as readonly string[]).includes(key)) throw notFound('report');
    const { format, ...f } = reportQuery.parse(query);
    return this.db.run(ctxOf(a), async (c) => {
      const result = await this.execute(c, a, key as ReportKey, f, false);
      if (format === 'csv') {
        // A CSV download is an export in every way that matters (it leaves the system), so it is held to export rules and recorded.
        const exp = await this.execute(c, a, key as ReportKey, f, true);
        await this.audit.record(c, a, 'report.download_csv', 'reports', null, null, { report: key, rows: exp.rows.length });
        return { result: exp, csv: toCsv(exp.columns.map((x) => x.label), exp.rows.map((r) => exp.columns.map((x) => r[x.key]))) };
      }
      return { result };
    });
  }

  // ---- stored exports -----------------------------------------------------------------------------------------------
  async createExport(a: RequestAuth, body: unknown): Promise<ExportView & { downloadUrl: string }> {
    const b = createExport.parse(body);
    const filters = reportFilters.parse(b.filters);
    return this.db.run(ctxOf(a, 'export created'), async (c) => {
      const r = await this.execute(c, a, b.reportKey, filters, true);
      const csv = Buffer.from(toCsv(r.columns.map((x) => x.label), r.rows.map((row) => r.columns.map((x) => row[x.key]))), 'utf8');
      const expires = new Date(Date.now() + EXPORT_TTL_MS);
      const fileId = await this.files.storeGenerated(c, a, 'export_result', `${b.reportKey}-${expires.toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8', csv, expires);
      const scope = { branchScope: a.branchScope.mode === 'listed' ? [...a.branchScope.branchIds] : 'all', sensitive: hasPermission(a, 'export.sensitive') };
      const row = (await c.query(
        `INSERT INTO export_jobs (tenant_id, report_key, filters, filters_hash, scope_snapshot, format, status, requested_by, result_file_id, row_count, expires_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,'csv','completed',$6,$7,$8,$9,now()) RETURNING id, report_key, format, status, row_count, created_at, expires_at`,
        [a.tenantId, b.reportKey, JSON.stringify(filters), createHash('sha256').update(JSON.stringify(filters)).digest('hex'), JSON.stringify(scope), a.userId, fileId, r.rows.length, expires])).rows[0]!;
      await this.audit.record(c, a, 'export.create', 'export_jobs', row.id, null, { report: b.reportKey, rows: r.rows.length, truncated: r.truncated, sensitive: scope.sensitive });
      const link = await this.files.issueLink(c, a, fileId);
      return { ...exportView(row), downloadUrl: link.url };
    });
  }

  async listExports(a: RequestAuth): Promise<ExportView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT id, report_key, format, status, row_count, created_at, expires_at FROM export_jobs WHERE tenant_id=$1 AND requested_by=$2 ORDER BY created_at DESC LIMIT 50`, [a.tenantId, a.userId])).rows.map(exportView));
  }

  async exportLink(a: RequestAuth, id: string): Promise<{ url: string; expiresAt: string }> {
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query<{ result_file_id: string | null; expires_at: Date | null }>('SELECT result_file_id, expires_at FROM export_jobs WHERE tenant_id=$1 AND id=$2 AND requested_by=$3', [a.tenantId, id, a.userId])).rows[0];
      if (!r) throw notFound('export');
      if (!r.result_file_id || (r.expires_at && r.expires_at.getTime() < Date.now())) throw new ApiError('invalid_state', 409, 'This export has expired; create it again');
      return this.files.issueLink(c, a, r.result_file_id);
    });
  }
}
