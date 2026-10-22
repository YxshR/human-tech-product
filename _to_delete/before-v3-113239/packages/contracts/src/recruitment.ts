import { z } from 'zod';
import { isoDate, money, uuid } from './common';
import { EMPLOYMENT_TYPES } from './employee';

const text = (max: number) => z.string().trim().min(1).max(max);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'use 2-30 letters, digits, - or _');
const phone = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'expected a phone number');
const when = z.string().datetime({ offset: true });

// ---- clients & job requirements -------------------------------------------------------------------------------------
const contact = z.object({ name: text(100).optional(), email: z.string().trim().toLowerCase().email().max(200).optional(), phone: phone.optional() }).strict();
export const CLIENT_STATUSES = ['active', 'inactive', 'archived'] as const;
export const createClient = z.object({ code, name: text(150), contact: contact.optional() }).strict();
export const updateClient = z.object({ name: text(150).optional(), contact: contact.optional(), status: z.enum(CLIENT_STATUSES).optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const JOB_STATUSES = ['open', 'on_hold', 'filled', 'closed'] as const;
export const createJob = z.object({
  code, title: text(150), clientId: uuid.optional(), location: text(100).optional(), openings: z.number().int().min(1).max(1000).default(1), ownerUserId: uuid.optional(),
}).strict();
export const updateJob = z.object({
  title: text(150).optional(), location: text(100).nullable().optional(), openings: z.number().int().min(1).max(1000).optional(),
  ownerUserId: uuid.nullable().optional(), status: z.enum(JOB_STATUSES).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'nothing to update');

// ---- candidates -----------------------------------------------------------------------------------------------------
export const PIPELINE_STAGES = ['lead_new', 'contacted', 'screening', 'submitted_to_client', 'interview', 'selected_offer', 'joined'] as const;
export const CANDIDATE_STAGES = [...PIPELINE_STAGES, 'rejected', 'withdrawn', 'on_hold'] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

const months = z.number().int().min(0).max(1200);
const tags = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20).transform((t) => [...new Set(t)]);
const candidateFields = {
  firstName: text(80), lastName: text(80).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(), phone: phone.optional(),
  city: text(80).optional(), source: text(60).optional(),
  clientId: uuid.nullable().optional(), jobRequirementId: uuid.nullable().optional(), roleTitle: text(120).optional(),
  recruiterUserId: uuid.nullable().optional(),
  totalExperienceMonths: months.optional(), relevantExperienceMonths: months.optional(), noticePeriodDays: z.number().int().min(0).max(365).optional(),
  availableFrom: isoDate.optional(), nextFollowUpAt: when.nullable().optional(), tags: tags.optional(),
};
export const createCandidate = z.object({ ...candidateFields, currentCtc: money.optional(), expectedCtc: money.optional() }).strict()
  .refine((v) => v.email || v.phone, { message: 'an email or a phone number is required', path: ['email'] })
  .refine((v) => v.relevantExperienceMonths === undefined || v.totalExperienceMonths === undefined || v.relevantExperienceMonths <= v.totalExperienceMonths,
    { message: 'relevant experience cannot exceed total experience', path: ['relevantExperienceMonths'] });
export const updateCandidate = z.object(candidateFields).partial().extend({
  email: candidateFields.email.nullable().optional(), phone: candidateFields.phone.nullable().optional(),
  version: z.number().int().min(1),
}).strict().refine((v) => Object.keys(v).length > 1, 'nothing to update');
export const setCandidateCompensation = z.object({ currentCtc: money.nullable(), expectedCtc: money.nullable() }).strict();
export const changeStage = z.object({ stage: z.enum(CANDIDATE_STAGES), reason: text(500).optional() }).strict();
export const convertCandidate = z.object({
  branchId: uuid, employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'), joinedAt: isoDate,
  departmentId: uuid.optional(), designationId: uuid.optional(), managerId: uuid.optional(), workEmail: z.string().trim().toLowerCase().email().max(200).optional(),
}).strict();
export const candidateListQuery = z.object({
  q: z.string().trim().max(100).optional(), stage: z.enum(CANDIDATE_STAGES).optional(), clientId: uuid.optional(), jobRequirementId: uuid.optional(),
  recruiterUserId: uuid.optional(), followUpDue: z.enum(['true']).optional(), archived: z.enum(['true']).optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const ACTIVITY_TYPES = ['note', 'call', 'email', 'meeting', 'follow_up'] as const;
export const addActivity = z.object({ type: z.enum(ACTIVITY_TYPES), body: text(2000), dueAt: when.optional() }).strict()
  .refine((v) => v.type === 'follow_up' ? !!v.dueAt : !v.dueAt, { message: 'only follow-ups have a due time, and they need one', path: ['dueAt'] });

export type ClientView = { id: string; code: string; name: string; contact: Record<string, unknown>; status: string };
export type JobView = { id: string; code: string; title: string; clientId: string | null; location: string | null; openings: number; filled: number; status: string; ownerUserId: string | null; openedAt: string; closedAt: string | null };
export type CandidateView = {
  id: string; candidateCode: string; firstName: string; lastName: string | null; email: string | null; phone: string | null; city: string | null; source: string | null;
  clientId: string | null; jobRequirementId: string | null; roleTitle: string | null; recruiterUserId: string | null;
  totalExperienceMonths: number | null; relevantExperienceMonths: number | null; noticePeriodDays: number | null; availableFrom: string | null;
  stage: CandidateStage; nextFollowUpAt: string | null; closureReason: string | null; tags: string[]; convertedEmployeeId: string | null; archived: boolean; version: number;
  currentCtc?: string | null; expectedCtc?: string | null;
};
export type StageHistoryView = { id: string; fromStage: string | null; toStage: string; reason: string | null; actorUserId: string | null; changedAt: string };
export type ActivityView = { id: string; type: string; body: string; dueAt: string | null; completedAt: string | null; createdBy: string | null; createdAt: string };
