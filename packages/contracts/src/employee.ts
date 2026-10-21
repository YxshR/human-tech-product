import { z } from 'zod';
import { isoDate, uuid } from './common';

export const EMPLOYMENT_STATUSES = ['onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'consultant'] as const;

const name = z.string().trim().min(1).max(100);
const phone = z.string().regex(/^\+?[0-9]{6,15}$/, 'digits only, optional leading +');

export const createEmployee = z.object({
  firstName: name,
  middleName: name.optional(),
  lastName: name.optional(),
  workEmail: z.string().email().max(254).transform((s) => s.toLowerCase()).optional(),
  personalEmail: z.string().email().max(254).transform((s) => s.toLowerCase()).optional(),
  phone: phone.optional(),
  branchId: uuid,
  departmentId: uuid.optional(),
  designationId: uuid.optional(),
  managerId: uuid.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  joinedAt: isoDate.optional(),
}).strict();
export type CreateEmployee = z.infer<typeof createEmployee>;

export const updateEmployee = createEmployee.partial().extend({
  /** Optimistic concurrency: the version the client last saw. */
  version: z.number().int().positive(),
}).strict();
export type UpdateEmployee = z.infer<typeof updateEmployee>;

/** What the API returns; sensitive fields appear only when the caller is authorised (see authz.redact). */
export const employeeView = z.object({
  id: uuid,
  employeeNumber: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  workEmail: z.string().nullable(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  branchId: uuid.nullable(),
  departmentId: uuid.nullable(),
  managerId: uuid.nullable(),
  joinedAt: isoDate.nullable(),
  version: z.number().int(),
  // field-gated
  dateOfBirth: isoDate.nullable().optional(),
  phone: z.string().nullable().optional(),
  personalEmail: z.string().nullable().optional(),
  panMasked: z.string().nullable().optional(),
  bankAccountMasked: z.string().nullable().optional(),
});
export type EmployeeView = z.infer<typeof employeeView>;

export const employeeListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(EMPLOYMENT_STATUSES).optional(),
  branchId: uuid.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
