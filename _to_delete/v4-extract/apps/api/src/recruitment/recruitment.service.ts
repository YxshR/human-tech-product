import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hasPermission, inBranchScope } from '@humantech/authz';
import {
  ActivityView, CandidateView, ClientView, JobView, StageHistoryView, addActivity, candidateListQuery, changeStage, convertCandidate, createCandidate, createClient, createJob,
  decodeCursor, encodeCursor, setCandidateCompensation, updateCandidate, updateClient, updateJob,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';
import { tenantToday } from '../common/employee-access';

const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
type Row = Record<string, unknown>;
const invalid = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);
const like = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
/** Same canonical form the table CHECK expects: digits with an optional leading +. */
const normalisePhone = (p: string): string => p.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');

const CLIENT = `SELECT id, code, name, contact, status FROM clients`;
const clientView = (r: Row): ClientView => ({ id: r.id as string, code: r.code as string, name: r.name as string, contact: r.contact as Record<string, unknown>, status: r.status as string });
const JOB = `SELECT j.id, j.code, j.title, j.client_id, j.location, j.openings, j.status, j.owner_user_id, to_char(j.opened_at,'YYYY-MM-DD') AS opened_at, to_char(j.closed_at,'YYYY-MM-DD') AS closed_at,
  (SELECT count(*)::int FROM candidates k WHERE k.tenant_id=j.tenant_id AND k.job_requirement_id=j.id AND k.current_stage='joined') AS filled FROM job_requirements j`;
const jobView = (r: Row): JobView => ({
  id: r.id as string, code: r.code as string, title: r.title as string, clientId: (r.client_id as string | null) ?? null, location: (r.location as string | null) ?? null,
  openings: r.openings as number, filled: r.filled as number, status: r.status as string, ownerUserId: (r.owner_user_id as string | null) ?? null, openedAt: r.opened_at as string, closedAt: (r.closed_at as string | null) ?? null,
});
const CAND = `SELECT c.id, c.candidate_code, c.first_name, c.last_name, c.email_normalized, c.phone_normalized, c.city, c.source, c.client_id, c.job_requirement_id, c.role_title,
  c.recruiter_user_id, c.total_experience_months, c.relevant_experience_months, c.notice_period_days, to_char(c.available_from,'YYYY-MM-DD') AS available_from,
  c.current_stage, c.next_follow_up_at, c.closure_reason, c.tags, c.converted_employee_id, c.archived_at, c.version,
  k.current_ctc::text AS current_ctc, k.expected_ctc::text AS expected_ctc,
  to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_key
  FROM candidates c LEFT JOIN candidate_compensation k ON k.tenant_id=c.tenant_id AND k.candidate_id=c.id`;

@Injectable()
export class RecruitmentService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  private candView(a: RequestAuth, r: Row): CandidateView {
    const v: CandidateView = {
      id: r.id as string, candidateCode: r.candidate_code as string, firstName: r.first_name as string, lastName: (r.last_name as string | null) ?? null,
      email: (r.email_normalized as string | null) ?? null, phone: (r.phone_normalized as string | null) ?? null, city: (r.city as string | null) ?? null, source: (r.source as string | null) ?? null,
      clientId: (r.client_id as string | null) ?? null, jobRequirementId: (r.job_requirement_id as string | null) ?? null, roleTitle: (r.role_title as string | null) ?? null,
      recruiterUserId: (r.recruiter_user_id as string | null) ?? null, totalExperienceMonths: (r.total_experience_months as number | null) ?? null,
      relevantExperienceMonths: (r.relevant_experience_months as number | null) ?? null, noticePeriodDays: (r.notice_period_days as number | null) ?? null,
      availableFrom: (r.available_from as string | null) ?? null, stage: r.current_stage as CandidateView['stage'], nextFollowUpAt: iso(r.next_follow_up_at as Date | null),
      closureReason: (r.closure_reason as string | null) ?? null, tags: r.tags as string[], convertedEmployeeId: (r.converted_employee_id as string | null) ?? null,
      archived: r.archived_at !== null, version: r.version as number,
    };
    if (hasPermission(a, 'candidate.read_salary')) { v.currentCtc = (r.current_ctc as string | null) ?? null; v.expectedCtc = (r.expected_ctc as string | null) ?? null; }
    return v;
  }

  // ---- clients ------------------------------------------------------------------------------------------------------
  async listClients(a: RequestAuth): Promise<ClientView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${CLIENT} WHERE tenant_id=$1 ORDER BY name`, [a.tenantId])).rows.map(clientView));
  }
  async createClient(a: RequestAuth, body: unknown): Promise<ClientView> {
    const b = createClient.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`INSERT INTO clients (tenant_id, code, name, contact) VALUES ($1,$2,$3,$4) RETURNING id, code, name, contact, status`,
        [a.tenantId, b.code, b.name, JSON.stringify(b.contact ?? {})])).rows[0]!;
      await this.audit.record(c, a, 'client.create', 'clients', r.id, null, { code: b.code });
      return clientView(r);
    });
  }
  async updateClient(a: RequestAuth, id: string, body: unknown): Promise<ClientView> {
    const b = updateClient.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`${CLIENT} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('client');
      const r = (await c.query(`UPDATE clients SET name=COALESCE($3,name), contact=COALESCE($4,contact), status=COALESCE($5,status) WHERE tenant_id=$1 AND id=$2 RETURNING id, code, name, contact, status`,
        [a.tenantId, id, b.name ?? null, b.contact ? JSON.stringify(b.contact) : null, b.status ?? null])).rows[0]!;
      await this.audit.record(c, a, 'client.update', 'clients', id, { status: cur.status }, { fields: Object.keys(b) });
      return clientView(r);
    });
  }

  // ---- job requirements ---------------------------------------------------------------------------------------------
  async listJobs(a: RequestAuth, q: { status?: string; clientId?: string }): Promise<JobView[]> {
    const where = ['j.tenant_id=$1']; const params: unknown[] = [a.tenantId];
    if (q.status) { params.push(q.status); where.push(`j.status=$${params.length}`); }
    if (q.clientId) { params.push(q.clientId); where.push(`j.client_id=$${params.length}`); }
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${JOB} WHERE ${where.join(' AND ')} ORDER BY j.opened_at DESC, j.code`, params)).rows.map(jobView));
  }
  async getJob(a: RequestAuth, id: string): Promise<JobView> {
    const r = await this.db.run(ctxOf(a), async (c) => (await c.query(`${JOB} WHERE j.tenant_id=$1 AND j.id=$2`, [a.tenantId, id])).rows[0]);
    if (!r) throw notFound('job requirement');
    return jobView(r);
  }
  private async assertMember(c: PoolClient, a: RequestAuth, userId: string, path: string): Promise<void> {
    const ok = (await c.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [a.tenantId, userId])).rows[0];
    if (!ok) throw invalid(path, 'that user is not an active member of this company');
  }
  async createJob(a: RequestAuth, body: unknown): Promise<JobView> {
    const b = createJob.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      if (b.clientId && !(await c.query('SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.clientId])).rows[0]) throw invalid('clientId', 'unknown client');
      if (b.ownerUserId) await this.assertMember(c, a, b.ownerUserId, 'ownerUserId');
      const id = (await c.query<{ id: string }>(
        `INSERT INTO job_requirements (tenant_id, client_id, code, title, location, openings, owner_user_id, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,(now() AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))::date) RETURNING id`,
        [a.tenantId, b.clientId ?? null, b.code, b.title, b.location ?? null, b.openings, b.ownerUserId ?? null])).rows[0]!.id;
      await this.audit.record(c, a, 'job.create', 'job_requirements', id, null, { code: b.code, openings: b.openings });
      return jobView((await c.query(`${JOB} WHERE j.tenant_id=$1 AND j.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }
  async updateJob(a: RequestAuth, id: string, body: unknown): Promise<JobView> {
    const b = updateJob.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`${JOB} WHERE j.tenant_id=$1 AND j.id=$2`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('job requirement');
      await c.query('SELECT 1 FROM job_requirements WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
      if (b.ownerUserId) await this.assertMember(c, a, b.ownerUserId, 'ownerUserId');
      const openings = b.openings ?? (cur.openings as number);
      if (openings < (cur.filled as number)) throw invalid('openings', `${cur.filled} candidates have already joined, so openings cannot be lower`);
      const status = b.status ?? (cur.status as string);
      if (status === 'filled' && (cur.filled as number) < openings) throw new ApiError('invalid_state', 409, 'A requirement is only filled once every opening has a joined candidate');
      const closing = ['filled', 'closed'].includes(status);
      await c.query(
        `UPDATE job_requirements SET title=COALESCE($3,title), location=CASE WHEN $4::boolean THEN $5 ELSE location END, openings=$6,
           owner_user_id=CASE WHEN $7::boolean THEN $8 ELSE owner_user_id END, status=$9,
           closed_at=CASE WHEN $10::boolean THEN COALESCE(closed_at, (now() AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))::date) ELSE NULL END
         WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.title ?? null, 'location' in b, b.location ?? null, openings, 'ownerUserId' in b, b.ownerUserId ?? null, status, closing]);
      await this.audit.record(c, a, 'job.update', 'job_requirements', id, { status: cur.status, openings: cur.openings }, { status, openings });
      return jobView((await c.query(`${JOB} WHERE j.tenant_id=$1 AND j.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }

  // ---- candidates ---------------------------------------------------------------------------------------------------
  private async assertRefs(c: PoolClient, a: RequestAuth, b: { clientId?: string | null; jobRequirementId?: string | null; recruiterUserId?: string | null }): Promise<void> {
    if (b.clientId && !(await c.query('SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.clientId])).rows[0]) throw invalid('clientId', 'unknown client');
    if (b.jobRequirementId && !(await c.query('SELECT 1 FROM job_requirements WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.jobRequirementId])).rows[0]) throw invalid('jobRequirementId', 'unknown job requirement');
    if (b.recruiterUserId) await this.assertMember(c, a, b.recruiterUserId, 'recruiterUserId');
  }
  private async assertNoDuplicate(c: PoolClient, a: RequestAuth, email: string | null, phone: string | null, exceptId?: string): Promise<void> {
    const d = (await c.query<{ candidate_code: string }>(
      `SELECT candidate_code FROM candidates WHERE tenant_id=$1 AND archived_at IS NULL AND ($4::uuid IS NULL OR id<>$4)
         AND (($2::text IS NOT NULL AND email_normalized=$2) OR ($3::text IS NOT NULL AND phone_normalized=$3)) LIMIT 1`, [a.tenantId, email, phone, exceptId ?? null])).rows[0];
    if (d) throw new ApiError('conflict', 409, `A candidate with the same email or phone already exists (${d.candidate_code})`);
  }
  private async load(c: PoolClient, a: RequestAuth, id: string, lock = false): Promise<Row> {
    const r = (await c.query(`${CAND} WHERE c.tenant_id=$1 AND c.id=$2${lock ? ' FOR UPDATE OF c' : ''}`, [a.tenantId, id])).rows[0];
    if (!r) throw notFound('candidate');
    return r;
  }

  async list(a: RequestAuth, query: unknown): Promise<{ data: CandidateView[]; nextCursor: string | null }> {
    const q = candidateListQuery.parse(query);
    const params: unknown[] = [a.tenantId]; const where = ['c.tenant_id=$1'];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    where.push(q.archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL');
    if (q.stage) where.push(`c.current_stage=${add(q.stage)}`);
    if (q.clientId) where.push(`c.client_id=${add(q.clientId)}`);
    if (q.jobRequirementId) where.push(`c.job_requirement_id=${add(q.jobRequirementId)}`);
    if (q.recruiterUserId) where.push(`c.recruiter_user_id=${add(q.recruiterUserId)}`);
    if (q.followUpDue) where.push(`c.next_follow_up_at <= now() AND c.current_stage NOT IN ('joined','rejected','withdrawn')`);
    if (q.q) {
      const p = add(like(q.q));
      where.push(`(c.first_name ILIKE ${p} OR c.last_name ILIKE ${p} OR c.candidate_code ILIKE ${p} OR c.email_normalized ILIKE ${p} OR c.phone_normalized ILIKE ${p} OR c.role_title ILIKE ${p})`);
    }
    if (q.cursor) {
      let key: Array<string | number>;
      try { key = decodeCursor(q.cursor); } catch { throw invalid('cursor', 'invalid cursor'); }
      if (typeof key[0] !== 'string' || typeof key[1] !== 'string' || !/^[0-9a-f-]{36}$/.test(key[1]) || Number.isNaN(Date.parse(`${key[0]}Z`))) throw invalid('cursor', 'invalid cursor');
      where.push(`(c.updated_at AT TIME ZONE 'UTC', c.id) < (${add(key[0])}::timestamp, ${add(key[1])}::uuid)`);
    }
    const limit = add(q.limit + 1);
    const rows = await this.db.run(ctxOf(a), async (c) =>
      (await c.query(`${CAND} WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limit}`, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: page.map((r) => this.candView(a, r)), nextCursor: rows.length > q.limit && last ? encodeCursor([last.updated_key as string, last.id as string]) : null };
  }

  async get(a: RequestAuth, id: string): Promise<CandidateView> {
    return this.db.run(ctxOf(a), async (c) => this.candView(a, await this.load(c, a, id)));
  }

  async create(a: RequestAuth, body: unknown): Promise<CandidateView> {
    const b = createCandidate.parse(body);
    if ((b.currentCtc !== undefined || b.expectedCtc !== undefined) && !hasPermission(a, 'candidate.read_salary')) throw forbidden('You cannot set candidate salary details');
    const email = b.email ?? null; const phone = b.phone ? normalisePhone(b.phone) : null;
    if (phone !== null && !/^\+?[0-9]{6,15}$/.test(phone)) throw invalid('phone', 'expected a phone number');
    return this.db.run(ctxOf(a, 'candidate created'), async (c) => {
      await this.assertRefs(c, a, b);
      await this.assertNoDuplicate(c, a, email, phone);
      const code = (await c.query<{ n: string }>(`SELECT app.next_number('candidate','CAN-',5::smallint) AS n`)).rows[0]!.n;
      const id = (await c.query<{ id: string }>(
        `INSERT INTO candidates (tenant_id, candidate_code, first_name, last_name, email_normalized, phone_normalized, city, source, client_id, job_requirement_id, role_title,
           recruiter_user_id, total_experience_months, relevant_experience_months, notice_period_days, available_from, next_follow_up_at, tags, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [a.tenantId, code, b.firstName, b.lastName ?? null, email, phone, b.city ?? null, b.source ?? null, b.clientId ?? null, b.jobRequirementId ?? null, b.roleTitle ?? null,
          b.recruiterUserId ?? a.userId, b.totalExperienceMonths ?? null, b.relevantExperienceMonths ?? null, b.noticePeriodDays ?? null, b.availableFrom ?? null,
          b.nextFollowUpAt ?? null, b.tags ?? [], a.userId])).rows[0]!.id;
      if (b.currentCtc !== undefined || b.expectedCtc !== undefined) {
        await c.query(`INSERT INTO candidate_compensation (tenant_id, candidate_id, current_ctc, expected_ctc, updated_by) VALUES ($1,$2,$3,$4,$5)`, [a.tenantId, id, b.currentCtc ?? null, b.expectedCtc ?? null, a.userId]);
      }
      await this.audit.record(c, a, 'candidate.create', 'candidates', id, null, { candidateCode: code });
      return this.candView(a, await this.load(c, a, id));
    });
  }

  async update(a: RequestAuth, id: string, body: unknown): Promise<CandidateView> {
    const { version, ...b } = updateCandidate.parse(body);
    return this.db.run(ctxOf(a, 'candidate updated'), async (c) => {
      const cur = await this.load(c, a, id, true);
      if (cur.archived_at) throw new ApiError('invalid_state', 409, 'An archived candidate cannot be edited');
      if (cur.converted_employee_id) throw new ApiError('invalid_state', 409, 'This candidate has joined and is now an employee');
      if (cur.version !== version) throw new ApiError('version_conflict', 409, 'This record was changed by someone else; reload and try again');
      await this.assertRefs(c, a, b);
      const email = 'email' in b ? (b.email ?? null) : (cur.email_normalized as string | null);
      const phone = 'phone' in b ? (b.phone ? normalisePhone(b.phone) : null) : (cur.phone_normalized as string | null);
      if (phone !== null && !/^\+?[0-9]{6,15}$/.test(phone)) throw invalid('phone', 'expected a phone number');
      if (email === null && phone === null) throw invalid('email', 'an email or a phone number is required');
      const total = b.totalExperienceMonths ?? (cur.total_experience_months as number | null);
      const relevant = b.relevantExperienceMonths ?? (cur.relevant_experience_months as number | null);
      if (total !== null && relevant !== null && relevant > total) throw invalid('relevantExperienceMonths', 'relevant experience cannot exceed total experience');
      if (email !== cur.email_normalized || phone !== cur.phone_normalized) await this.assertNoDuplicate(c, a, email, phone, id);
      const COL: Record<string, string> = {
        firstName: 'first_name', lastName: 'last_name', city: 'city', source: 'source', clientId: 'client_id', jobRequirementId: 'job_requirement_id', roleTitle: 'role_title',
        recruiterUserId: 'recruiter_user_id', totalExperienceMonths: 'total_experience_months', relevantExperienceMonths: 'relevant_experience_months',
        noticePeriodDays: 'notice_period_days', availableFrom: 'available_from', nextFollowUpAt: 'next_follow_up_at', tags: 'tags',
      };
      const sets: string[] = ['email_normalized=$3', 'phone_normalized=$4']; const params: unknown[] = [a.tenantId, id, email, phone];
      for (const [k, v] of Object.entries(b)) {
        if (k === 'email' || k === 'phone') continue;
        params.push(v ?? null); sets.push(`${COL[k]}=$${params.length}`);
      }
      await c.query(`UPDATE candidates SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2`, params);
      await this.audit.record(c, a, 'candidate.update', 'candidates', id, null, { fields: Object.keys(b) });   // field names only: contact details stay out of the log
      return this.candView(a, await this.load(c, a, id));
    });
  }

  async setCompensation(a: RequestAuth, id: string, body: unknown): Promise<CandidateView> {
    const b = setCandidateCompensation.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cur = await this.load(c, a, id, true);
      if (cur.archived_at || cur.converted_employee_id) throw new ApiError('invalid_state', 409, 'This candidate can no longer be edited');
      await c.query(
        `INSERT INTO candidate_compensation (tenant_id, candidate_id, current_ctc, expected_ctc, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, candidate_id) DO UPDATE SET current_ctc=EXCLUDED.current_ctc, expected_ctc=EXCLUDED.expected_ctc, updated_by=EXCLUDED.updated_by`,
        [a.tenantId, id, b.currentCtc, b.expectedCtc, a.userId]);
      await this.audit.record(c, a, 'candidate.salary_update', 'candidates', id, null, { fields: ['currentCtc', 'expectedCtc'] });
      return this.candView(a, await this.load(c, a, id));
    });
  }

  async archive(a: RequestAuth, id: string, restore: boolean): Promise<CandidateView> {
    return this.db.run(ctxOf(a), async (c) => {
      const cur = await this.load(c, a, id, true);
      if (cur.converted_employee_id) throw new ApiError('invalid_state', 409, 'This candidate has joined and is now an employee');
      if (restore) await this.assertNoDuplicate(c, a, cur.email_normalized as string | null, cur.phone_normalized as string | null, id);
      await c.query(`UPDATE candidates SET archived_at=${restore ? 'NULL' : 'COALESCE(archived_at, now())'} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await this.audit.record(c, a, restore ? 'candidate.restore' : 'candidate.archive', 'candidates', id, null, null);
      return this.candView(a, await this.load(c, a, id));
    });
  }

  async changeStage(a: RequestAuth, id: string, body: unknown): Promise<CandidateView> {
    const b = changeStage.parse(body);
    if (b.stage === 'joined') throw new ApiError('invalid_state', 409, 'A candidate joins by being converted to an employee');
    return this.db.run(ctxOf(a, b.reason), async (c) => {
      const cur = await this.load(c, a, id, true);
      if (cur.archived_at) throw new ApiError('invalid_state', 409, 'An archived candidate cannot change stage');
      const from = cur.current_stage as string;
      if (from === b.stage) throw new ApiError('invalid_state', 409, `The candidate is already in ${from}`);
      const needs = (await c.query<{ n: boolean }>('SELECT app.candidate_stage_needs_reason($1,$2) AS n', [from, b.stage])).rows[0]!.n;
      if (needs && !b.reason) throw invalid('reason', `A reason is required to move from ${from} to ${b.stage}`);
      const closing = b.stage === 'rejected' || b.stage === 'withdrawn';
      await c.query(
        `UPDATE candidates SET current_stage=$3, closure_reason=$4,
           next_follow_up_at=CASE WHEN $5::boolean THEN NULL ELSE next_follow_up_at END WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.stage, closing ? b.reason : null, closing]);       // the DB trigger validates the transition and writes the history row
      await this.audit.record(c, a, 'candidate.stage_change', 'candidates', id, { stage: from }, { stage: b.stage }, b.reason);
      return this.candView(a, await this.load(c, a, id));
    });
  }

  async history(a: RequestAuth, id: string): Promise<StageHistoryView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await this.load(c, a, id);
      return (await c.query(`SELECT id, from_stage, to_stage, reason, actor_user_id, changed_at FROM candidate_stage_history WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY changed_at, id`, [a.tenantId, id]))
        .rows.map((r) => ({ id: r.id, fromStage: r.from_stage, toStage: r.to_stage, reason: r.reason, actorUserId: r.actor_user_id, changedAt: (r.changed_at as Date).toISOString() }));
    });
  }

  // ---- activities ---------------------------------------------------------------------------------------------------
  private actView = (r: Row): ActivityView => ({
    id: r.id as string, type: r.activity_type as string, body: r.body as string, dueAt: iso(r.due_at as Date | null), completedAt: iso(r.completed_at as Date | null),
    createdBy: (r.created_by as string | null) ?? null, createdAt: (r.created_at as Date).toISOString(),
  });
  private async refreshFollowUp(c: PoolClient, tenantId: string, candidateId: string): Promise<void> {
    await c.query(
      `UPDATE candidates SET next_follow_up_at=(SELECT min(due_at) FROM candidate_activities WHERE tenant_id=$1 AND candidate_id=$2 AND activity_type='follow_up' AND completed_at IS NULL)
       WHERE tenant_id=$1 AND id=$2`, [tenantId, candidateId]);
  }
  async listActivities(a: RequestAuth, id: string): Promise<ActivityView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await this.load(c, a, id);
      return (await c.query(`SELECT id, activity_type, body, due_at, completed_at, created_by, created_at FROM candidate_activities WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY created_at DESC, id`, [a.tenantId, id])).rows.map(this.actView);
    });
  }
  async addActivity(a: RequestAuth, id: string, body: unknown): Promise<ActivityView> {
    const b = addActivity.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cand = await this.load(c, a, id, true);
      if (cand.archived_at) throw new ApiError('invalid_state', 409, 'An archived candidate cannot be changed');
      const r = (await c.query(
        `INSERT INTO candidate_activities (tenant_id, candidate_id, activity_type, body, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, activity_type, body, due_at, completed_at, created_by, created_at`, [a.tenantId, id, b.type, b.body, b.dueAt ?? null, a.userId])).rows[0]!;
      if (b.type === 'follow_up') await this.refreshFollowUp(c, a.tenantId, id);
      return this.actView(r);
    });
  }
  async completeActivity(a: RequestAuth, activityId: string): Promise<ActivityView> {
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query<{ candidate_id: string; completed_at: Date | null }>(
        `SELECT candidate_id, completed_at FROM candidate_activities WHERE tenant_id=$1 AND id=$2 AND activity_type='follow_up' FOR UPDATE`, [a.tenantId, activityId])).rows[0];
      if (!cur) throw notFound('follow-up');
      if (cur.completed_at) throw new ApiError('invalid_state', 409, 'This follow-up is already completed');
      const r = (await c.query(`UPDATE candidate_activities SET completed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id, activity_type, body, due_at, completed_at, created_by, created_at`, [a.tenantId, activityId])).rows[0]!;
      await this.refreshFollowUp(c, a.tenantId, cur.candidate_id);
      return this.actView(r);
    });
  }

  // ---- conversion ---------------------------------------------------------------------------------------------------
  /** Selected candidate -> employee record (status 'onboarding'), one-to-one, with the stage moved to 'joined' in the same transaction. */
  async convert(a: RequestAuth, id: string, body: unknown): Promise<{ candidate: CandidateView; employeeId: string; employeeNumber: string }> {
    const b = convertCandidate.parse(body);
    if (!inBranchScope(a, { tenantId: a.tenantId, branchId: b.branchId }).allowed) throw notFound('branch');
    return this.db.run(ctxOf(a, 'converted to employee'), async (c) => {
      const cand = await this.load(c, a, id, true);
      if (cand.archived_at) throw new ApiError('invalid_state', 409, 'An archived candidate cannot be converted');
      if (cand.converted_employee_id) throw new ApiError('conflict', 409, 'This candidate has already been converted');
      if (cand.current_stage !== 'selected_offer') throw new ApiError('invalid_state', 409, 'Only a candidate at the selected_offer stage can be converted');
      if (!(await c.query('SELECT 1 FROM branches WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.branchId])).rows[0]) throw notFound('branch');
      const today = await tenantToday(c, a.tenantId);
      const number = (await c.query<{ n: string }>('SELECT app.next_employee_number() AS n')).rows[0]!.n;
      const emp = (await c.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, work_email, personal_email, phone, branch_id, department_id, designation_id, manager_id,
                                employment_type, joined_at, created_by, employment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'onboarding') RETURNING id`,
        [a.tenantId, number, cand.first_name, cand.last_name, b.workEmail ?? null, cand.email_normalized, cand.phone_normalized, b.branchId, b.departmentId ?? null,
          b.designationId ?? null, b.managerId ?? null, b.employmentType, b.joinedAt, a.userId])).rows[0]!;
      await c.query(`UPDATE candidates SET current_stage='joined', converted_employee_id=$3, next_follow_up_at=NULL WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, emp.id]);
      if (cand.job_requirement_id) {
        await c.query(
          `UPDATE job_requirements j SET status='filled', closed_at=COALESCE(closed_at,$3::date)
            WHERE j.tenant_id=$1 AND j.id=$2 AND j.status='open'
              AND (SELECT count(*) FROM candidates k WHERE k.tenant_id=j.tenant_id AND k.job_requirement_id=j.id AND k.current_stage='joined') >= j.openings`,
          [a.tenantId, cand.job_requirement_id, today]);
      }
      await this.audit.record(c, a, 'candidate.convert', 'candidates', id, { stage: 'selected_offer' }, { stage: 'joined', employeeId: emp.id, employeeNumber: number });
      return { candidate: this.candView(a, await this.load(c, a, id)), employeeId: emp.id, employeeNumber: number };
    });
  }
}
