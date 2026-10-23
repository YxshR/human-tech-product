import { z } from 'zod';
import { isoDate, uuid } from './common';

const text = (max: number) => z.string().trim().min(1).max(max);
const address = z.object({
  line1: text(120), line2: text(120).optional(), city: text(80), state: text(80), postalCode: text(12), country: text(2).default('IN'),
}).strict();
const phone = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'expected a phone number');

export const GENDERS = ['female', 'male', 'non_binary', 'undisclosed'] as const;
export const MARITAL = ['single', 'married', 'divorced', 'widowed', 'undisclosed'] as const;
export const updatePersonal = z.object({
  dateOfBirth: isoDate.nullable().optional(), gender: z.enum(GENDERS).nullable().optional(), maritalStatus: z.enum(MARITAL).nullable().optional(),
  nationality: text(60).nullable().optional(), currentAddress: address.nullable().optional(), permanentAddress: address.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const createEmergencyContact = z.object({ name: text(100), relationship: text(40), phone }).strict();

export const IDENTIFIER_TYPES = ['pan', 'uan', 'esic_ip', 'passport', 'driving_licence'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];
export const IDENTIFIER_PATTERNS: Record<IdentifierType, { re: RegExp; hint: string }> = {
  pan: { re: /^[A-Z]{5}[0-9]{4}[A-Z]$/, hint: 'AAAAA9999A' },
  uan: { re: /^[0-9]{12}$/, hint: '12 digits' },
  esic_ip: { re: /^[0-9]{10,17}$/, hint: '10 to 17 digits' },
  passport: { re: /^[A-Z][0-9]{7}$/, hint: 'A1234567' },
  driving_licence: { re: /^[A-Z0-9]{8,20}$/, hint: '8 to 20 letters or digits' },
};
/** Upper-case and strip separators so equal identifiers always compare (and hash) equal. */
export const normaliseIdentifier = (v: string): string => v.toUpperCase().replace(/[\s-]/g, '');
export const identifierType = z.enum(IDENTIFIER_TYPES);
export const setIdentifier = z.object({ value: z.string().trim().min(4).max(30) }).strict();

export const createBank = z.object({
  accountHolderName: text(100), accountNumber: z.string().trim().regex(/^[0-9]{9,18}$/, '9 to 18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'expected an IFSC such as HDFC0001234'),
  bankName: text(80).optional(), effectiveFrom: isoDate,
}).strict();
export const reviewBank = z.object({ comment: z.string().trim().max(300).optional() }).strict();

export const DOCUMENT_TYPES = ['id_proof', 'address_proof', 'pan_card', 'education', 'experience', 'offer_letter', 'contract', 'bank_proof', 'other'] as const;
export const DOCUMENT_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const createDocument = z.object({
  documentType: z.enum(DOCUMENT_TYPES), title: text(120).optional(), filename: z.string().trim().min(1).max(150).regex(/^[^/\\\0]+$/, 'no path separators'),
  contentType: z.enum(DOCUMENT_CONTENT_TYPES), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), expiresOn: isoDate.nullish(),
}).strict();

export const createTemplate = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/), phase: z.enum(['onboarding', 'offboarding']).default('onboarding'),
  title: text(150), description: z.string().trim().max(500).optional(), ownerRoleKey: z.string().trim().max(40).optional(),
  dueOffsetDays: z.number().int().min(-30).max(365).default(0), required: z.boolean().default(true), displayOrder: z.number().int().min(0).max(1000).default(0),
}).strict();
export const updateTemplate = z.object({
  title: text(150).optional(), description: z.string().trim().max(500).nullable().optional(), ownerRoleKey: z.string().trim().max(40).nullable().optional(),
  dueOffsetDays: z.number().int().min(-30).max(365).optional(), required: z.boolean().optional(), displayOrder: z.number().int().min(0).max(1000).optional(), active: z.boolean().optional(),
}).strict();
export const completeOnboarding = z.object({ employmentStatus: z.enum(['active', 'probation']).default('active') }).strict();
export const instantiateTasks = z.object({ phase: z.enum(['onboarding', 'offboarding']).default('onboarding'), anchorDate: isoDate.optional() }).strict();
export const updateTask = z.object({
  status: z.enum(['pending', 'in_progress', 'done', 'waived']), waiverReason: z.string().trim().min(5).max(300).optional(), ownerUserId: uuid.nullable().optional(),
}).strict();
export const createTask = z.object({ phase: z.enum(['onboarding', 'offboarding']).default('onboarding'), title: text(150), dueDate: isoDate.nullish(), required: z.boolean().default(false) }).strict();

export const EXIT_STATUSES = ['initiated', 'notice_period', 'clearance', 'settlement_pending', 'completed', 'cancelled'] as const;
export const EXIT_TRANSITIONS: Record<string, readonly string[]> = {
  initiated: ['notice_period', 'clearance', 'cancelled'], notice_period: ['clearance', 'cancelled'], clearance: ['settlement_pending', 'cancelled'],
  settlement_pending: ['completed', 'cancelled'], completed: [], cancelled: [],
};
export const startExit = z.object({
  resignationDate: isoDate.nullish(), lastWorkingDate: isoDate, reasonCode: text(40).optional(), reasonNotes: z.string().trim().max(1000).optional(), createTasks: z.boolean().default(true),
}).strict().refine((v) => !v.resignationDate || v.lastWorkingDate >= v.resignationDate, { path: ['lastWorkingDate'], message: 'must not be before the resignation date' });
export const updateExit = z.object({
  status: z.enum(EXIT_STATUSES).optional(), lastWorkingDate: isoDate.optional(), reasonNotes: z.string().trim().max(1000).optional(),
  finalSettlementStatus: z.enum(['not_started', 'in_progress', 'paid', 'not_applicable']).optional(), revokeAccess: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const requestProfileChange = z.object({
  changes: z.object({
    phone: phone.optional(), personalEmail: z.string().trim().toLowerCase().email().max(254).optional(), maritalStatus: z.enum(MARITAL).optional(),
    currentAddress: address.optional(), permanentAddress: address.optional(),
  }).strict().refine((v) => Object.keys(v).length > 0, 'at least one change is required'),
}).strict();
export const reviewProfileChange = z.object({ comment: z.string().trim().max(300).optional() }).strict();

export type PersonalView = { employeeId: string; dateOfBirth: string | null; gender: string | null; maritalStatus: string | null; nationality: string | null; currentAddress: Record<string, unknown>; permanentAddress: Record<string, unknown> };
export type EmergencyContactView = { id: string; name: string; relationship: string; phone: string };
export type IdentifierView = { type: IdentifierType; masked: string; verifiedAt: string | null };
export type BankView = { id: string; accountHolderName: string; bankName: string | null; accountNumberMasked: string; ifsc: string | null; status: string; effectiveFrom: string; effectiveTo: string | null; createdBy: string | null; verifiedBy: string | null };
export type DocumentView = { id: string; employeeId: string; documentType: string; title: string | null; filename: string | null; contentType: string; sizeBytes: number; status: string; verifiedAt: string | null; expiresOn: string | null; createdAt: string };
export type TemplateView = { id: string; code: string; phase: string; title: string; description: string | null; ownerRoleKey: string | null; dueOffsetDays: number; required: boolean; active: boolean; displayOrder: number };
export type TaskView = { id: string; employeeId: string; phase: string; title: string; ownerUserId: string | null; dueDate: string | null; required: boolean; status: string; completedBy: string | null; completedAt: string | null; waiverReason: string | null };
export type ExitView = { id: string; employeeId: string; status: string; resignationDate: string | null; lastWorkingDate: string; reasonCode: string | null; reasonNotes: string | null; accessRevokedAt: string | null; finalSettlementStatus: string; initiatedBy: string | null };
export type ProfileChangeView = { id: string; employeeId: string; employeeName: string; changes: Record<string, unknown>; status: string; requestedBy: string | null; reviewedBy: string | null; reviewComment: string | null; createdAt: string };
