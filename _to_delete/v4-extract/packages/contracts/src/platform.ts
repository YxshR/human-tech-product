import { z } from 'zod';
import { isoDate, uuid } from './common';
import { EMPLOYMENT_TYPES } from './employee';

const cursorPage = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) };

// ---- notifications ----------------------------------------------------------------------------------------------------
export const notificationListQuery = z.object({ unread: z.enum(['true']).optional(), ...cursorPage }).strict();
export const setNotificationPreference = z.object({ inAppEnabled: z.boolean().optional(), emailEnabled: z.boolean().optional() }).strict()
  .refine((v) => v.inAppEnabled !== undefined || v.emailEnabled !== undefined, 'nothing to update');
export const eventKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'expected an event key such as leave.approved');
export type NotificationView = { id: string; eventKey: string; title: string; body: string | null; data: Record<string, unknown>; readAt: string | null; createdAt: string };
export type PreferenceView = { eventKey: string; inAppEnabled: boolean; emailEnabled: boolean };

// ---- audit viewer -----------------------------------------------------------------------------------------------------
export const auditQuery = z.object({
  entityType: z.string().trim().min(1).max(60).optional(), entityId: uuid.optional(), actorUserId: uuid.optional(),
  action: z.string().trim().min(1).max(80).optional(), from: isoDate.optional(), to: isoDate.optional(), ...cursorPage,
}).strict();
export type AuditView = { id: string; action: string; entityType: string; entityId: string | null; actorUserId: string | null; actorName: string | null; reason: string | null; before: unknown; after: unknown; requestId: string | null; source: string; createdAt: string };

// ---- reports & exports ------------------------------------------------------------------------------------------------
export const REPORT_KEYS = ['headcount', 'employees', 'attendance_summary', 'leave_balances', 'hiring_funnel', 'candidates'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const reportFilters = z.object({
  branchId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(), asOf: isoDate.optional(),
  status: z.string().trim().min(1).max(40).optional(),
}).strict();
export type ReportFilters = z.infer<typeof reportFilters>;
export const reportQuery = reportFilters.extend({ format: z.enum(['json', 'csv']).default('json') }).strict();
export const createExport = z.object({ reportKey: z.enum(REPORT_KEYS), filters: reportFilters.default({}) }).strict();
export type ReportResult = { key: ReportKey; title: string; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number | null>>; truncated: boolean };
export type ExportView = { id: string; reportKey: string; format: string; status: string; rowCount: number | null; createdAt: string; expiresAt: string | null };
export const NOTIFICATION_EVENTS = [
  'leave.approved', 'leave.rejected', 'profile_change.approved', 'profile_change.rejected', 'bank.verified', 'bank.rejected', 'payslip.ready',
] as const;

// ---- imports ------------------------------------------------------------------------------------------------------------
export const IMPORT_TYPES = ['employees', 'candidates'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];
export const importQuery = z.object({ duplicatePolicy: z.enum(['reject', 'skip']).default('reject'), filename: z.string().trim().min(1).max(120).optional() }).strict();
const t = (max: number) => z.string().trim().min(1).max(max);
const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === undefined ? undefined : v), s.optional());
/** One CSV row after header normalisation (snake_case). Empty cells are treated as missing. */
export const employeeImportRow = z.object({
  first_name: t(80), last_name: optional(t(80)), work_email: optional(z.string().trim().toLowerCase().email().max(200)), personal_email: optional(z.string().trim().toLowerCase().email().max(200)),
  phone: optional(z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'expected a phone number')), branch_code: t(30), department_code: optional(t(30)),
  employment_type: optional(z.enum(EMPLOYMENT_TYPES)), joined_at: isoDate,
}).strict();
export const candidateImportRow = z.object({
  first_name: t(80), last_name: optional(t(80)), email: optional(z.string().trim().toLowerCase().email().max(200)),
  phone: optional(z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'expected a phone number')), city: optional(t(80)), source: optional(t(60)), role_title: optional(t(120)),
  total_experience_months: optional(z.coerce.number().int().min(0).max(1200)), notice_period_days: optional(z.coerce.number().int().min(0).max(365)),
}).strict().refine((v) => v.email || v.phone, { message: 'an email or a phone number is required', path: ['email'] });
export const IMPORT_COLUMNS: Record<ImportType, { required: string[]; optional: string[] }> = {
  employees: { required: ['first_name', 'branch_code', 'joined_at'], optional: ['last_name', 'work_email', 'personal_email', 'phone', 'department_code', 'employment_type'] },
  candidates: { required: ['first_name'], optional: ['last_name', 'email', 'phone', 'city', 'source', 'role_title', 'total_experience_months', 'notice_period_days'] },
};
export type ImportView = {
  id: string; importType: string; status: string; totalRows: number | null; acceptedRows: number | null; rejectedRows: number | null; skippedRows: number; duplicatePolicy: string;
  createdAt: string; completedAt: string | null; errors: Array<{ row: number; messages: string[] }>; hasResult: boolean;
};

// ---- custom fields ------------------------------------------------------------------------------------------------------
export const CUSTOM_ENTITIES = ['employee', 'candidate'] as const;
export const CUSTOM_VALUE_TYPES = ['short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox', 'email', 'phone', 'url'] as const;
export type CustomValueType = (typeof CUSTOM_VALUE_TYPES)[number];
const optionList = z.array(z.string().trim().min(1).max(60)).min(1).max(50).refine((o) => new Set(o).size === o.length, 'options must be unique');
export const createCustomField = z.object({
  entityType: z.enum(CUSTOM_ENTITIES), internalKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'use lower-case letters, digits and _'), label: t(80), valueType: z.enum(CUSTOM_VALUE_TYPES),
  required: z.boolean().default(false), options: optionList.optional(),
}).strict().refine((v) => (v.valueType === 'single_select' || v.valueType === 'multi_select') === (v.options !== undefined), { message: 'options are needed for select fields, and only for them', path: ['options'] });
export const updateCustomField = z.object({ label: t(80).optional(), required: z.boolean().optional(), options: optionList.optional(), active: z.boolean().optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export const setCustomValues = z.object({ values: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown()) }).strict();
export type CustomFieldView = { id: string; entityType: string; internalKey: string; label: string; valueType: string; required: boolean; options: string[]; active: boolean };

// ---- saved views --------------------------------------------------------------------------------------------------------
export const VIEW_ENTITIES: Record<string, { columns: string[]; filters: string[] }> = {
  employees: { columns: ['employeeNumber', 'name', 'workEmail', 'status', 'branch', 'department', 'joinedAt'], filters: ['status', 'branchId', 'q'] },
  candidates: { columns: ['candidateCode', 'name', 'email', 'phone', 'stage', 'source', 'role', 'recruiter'], filters: ['stage', 'clientId', 'jobRequirementId', 'recruiterUserId', 'q'] },
  leave_requests: { columns: ['employee', 'type', 'start', 'end', 'days', 'status'], filters: ['status', 'employeeId'] },
};
export const viewConfig = z.object({
  columns: z.array(z.string().min(1).max(40)).max(30).optional(),
  filters: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  sort: z.object({ key: z.string().min(1).max(40), direction: z.enum(['asc', 'desc']) }).strict().optional(),
}).strict();
export const createView = z.object({ entityType: z.enum(Object.keys(VIEW_ENTITIES) as [string, ...string[]]), name: t(60), config: viewConfig, shared: z.boolean().default(false) }).strict();
export const updateView = z.object({ name: t(60).optional(), config: viewConfig.optional(), shared: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type ViewView = { id: string; entityType: string; name: string; config: z.infer<typeof viewConfig>; shared: boolean; mine: boolean };

// ---- privacy & retention ------------------------------------------------------------------------------------------------
export const PRIVACY_REQUEST_TYPES = ['access', 'correction', 'erasure', 'grievance'] as const;
export const PRIVACY_STATUSES = ['received', 'in_progress', 'completed', 'rejected'] as const;
export const PRIVACY_TRANSITIONS: Record<string, string[]> = { received: ['in_progress', 'rejected'], in_progress: ['completed', 'rejected'], completed: [], rejected: [] };
export const createPrivacyRequest = z.object({
  requestType: z.enum(PRIVACY_REQUEST_TYPES), details: t(2000).optional(), subjectEmployeeId: uuid.optional(), subjectCandidateId: uuid.optional(),
}).strict();
export const updatePrivacyRequest = z.object({ status: z.enum(PRIVACY_STATUSES), resolutionNote: t(2000).optional() }).strict();
export type PrivacyRequestView = {
  id: string; requestType: string; status: string; subjectEmployeeId: string | null; subjectCandidateId: string | null; details: string | null; dueAt: string | null;
  handledBy: string | null; resolutionNote: string | null; createdAt: string; completedAt: string | null;
};
export const RETENTION_ENTITIES = ['candidate', 'employee', 'payroll', 'attendance', 'audit', 'stored_file', 'notification'] as const;
export const setRetention = z.object({
  entityType: z.enum(RETENTION_ENTITIES), retainMonths: z.number().int().min(1).max(1200), actionAfter: z.enum(['anonymise', 'delete', 'archive']), legalBasis: t(500).optional(),
}).strict();
export type RetentionView = { entityType: string; retainMonths: number; actionAfter: string; legalBasis: string | null };

// ---- billing (read-only for the company) --------------------------------------------------------------------------------
export type BillingView = {
  plan: { code: string; name: string; maxActiveEmployees: number | null; maxBranches: number | null; monthlyPrice: string | null; currency: string } | null;
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; overLimitBehaviour: string; employeeLimit: number | null } | null;
  usage: { activeEmployees: number; branches: number };
  invoices: Array<{ invoiceNumber: string; periodStart: string; periodEnd: string; amount: string; currency: string; status: string; issuedAt: string }>;
};
