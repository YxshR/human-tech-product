import { z } from 'zod';
import { isoDate, money, uuid } from './common';

const componentCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,30}$/, 'A-Z, digits and _, starting with a letter');
const percent = z.string().regex(/^\d{1,4}(\.\d{1,6})?$/, 'expected a decimal percentage such as "12.5"');

export const COMPONENT_TYPES = ['earning', 'employee_deduction', 'employer_contribution', 'informational'] as const;
/** Methods this release can run. `per_unit` and `manual` need period-input screens and are rejected until then. */
export const SUPPORTED_METHODS = ['fixed', 'percentage_of_component', 'per_day', 'statutory'] as const;
export const STATUTORY_GROUPS = ['pf', 'esi', 'professional_tax', 'tds', 'lwf', 'gratuity', 'bonus', 'other'] as const;

export const createComponent = z.object({
  code: componentCode, label: z.string().trim().min(2).max(80), componentType: z.enum(COMPONENT_TYPES),
}).strict();
export const updateComponent = z.object({ label: z.string().trim().min(2).max(80).optional(), active: z.boolean().optional() }).strict();

export const createComponentVersion = z.object({
  calculationMethod: z.enum(SUPPORTED_METHODS),
  baseComponentCodes: z.array(componentCode).max(10).default([]),
  defaultAmount: money.nullish(), defaultPercentage: percent.nullish(),
  roundingMode: z.enum(['half_up', 'half_even', 'down', 'up']).default('half_up'),
  roundingPlaces: z.number().int().min(0).max(2).default(2),
  isTaxable: z.boolean().default(true), prorateOnUnpaidDays: z.boolean().default(true),
  statutoryGroup: z.enum(STATUTORY_GROUPS).nullish(),
  /** `balance: true` makes a fixed component the balancing figure up to the assignment's monthly CTC. */
  configuration: z.object({ balance: z.boolean().optional(), basis: z.enum(['full', 'earned']).optional(), stateScoped: z.boolean().optional() }).strict().default({}),
  effectiveFrom: isoDate, effectiveTo: isoDate.nullish(),
}).strict().superRefine((v, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) bad('effectiveTo', 'must not be before effectiveFrom');
  if (v.calculationMethod === 'percentage_of_component' && (!v.defaultPercentage || v.baseComponentCodes.length === 0)) bad('defaultPercentage', 'a percentage and base components are required');
  if (v.calculationMethod === 'statutory' && !v.statutoryGroup) bad('statutoryGroup', 'required for statutory components');
  if (v.calculationMethod === 'per_day' && !v.defaultAmount) bad('defaultAmount', 'a per-day rate is required');
  if (v.configuration.balance && v.calculationMethod !== 'fixed') bad('configuration', 'only fixed components can be the balancing figure');
});

export const structureComponent = z.object({
  componentVersionId: uuid, amount: money.nullish(), percentage: percent.nullish(), displayOrder: z.number().int().min(0).max(1000).default(0),
}).strict();
export const createStructure = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'letters, digits, - or _'),
  name: z.string().trim().min(2).max(100), effectiveFrom: isoDate, effectiveTo: isoDate.nullish(),
  components: z.array(structureComponent).min(1).max(60),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'must not be before effectiveFrom' })
  .refine((v) => new Set(v.components.map((c) => c.componentVersionId)).size === v.components.length, { path: ['components'], message: 'duplicate component version' });
export const updateStructure = z.object({
  name: z.string().trim().min(2).max(100).optional(), effectiveFrom: isoDate.optional(), effectiveTo: isoDate.nullish(),
  components: z.array(structureComponent).min(1).max(60).optional(),
}).strict();

export const proposeAssignment = z.object({
  employeeId: uuid, salaryStructureId: uuid, effectiveFrom: isoDate, effectiveTo: isoDate.nullish(),
  monthlyCtc: money, changeReason: z.string().trim().min(5).max(500),
  overrides: z.array(z.object({ componentVersionId: uuid, amount: money.nullish(), percentage: percent.nullish() }).strict()).max(60).default([]),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'must not be before effectiveFrom' });
export const reviewAssignment = z.object({ comment: z.string().trim().max(500).optional() }).strict();

export type ComponentView = { id: string; code: string; label: string; componentType: string; active: boolean; versions: ComponentVersionView[] };
export type ComponentVersionView = {
  id: string; version: number; calculationMethod: string; baseComponentCodes: string[]; defaultAmount: string | null; defaultPercentage: string | null;
  roundingMode: string; roundingPlaces: number; isTaxable: boolean; prorateOnUnpaidDays: boolean; statutoryGroup: string | null;
  configuration: Record<string, unknown>; effectiveFrom: string; effectiveTo: string | null; status: 'draft' | 'active' | 'retired';
};
export type StructureView = {
  id: string; code: string; name: string; version: number; effectiveFrom: string; effectiveTo: string | null; status: 'draft' | 'active' | 'retired';
  components: Array<{ componentVersionId: string; componentCode: string; label: string; amount: string | null; percentage: string | null; displayOrder: number }>;
};
export type AssignmentView = {
  id: string; employeeId: string; employeeName: string; salaryStructureId: string; structureCode: string; revision: number; effectiveFrom: string; effectiveTo: string | null;
  monthlyCtc: string; currency: string; changeReason: string; approvalStatus: 'pending' | 'approved' | 'rejected'; createdBy: string | null; approvedBy: string | null;
  overrides: Array<{ componentVersionId: string; amount: string | null; percentage: string | null }>;
};
