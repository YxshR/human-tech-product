import { PermissionKey } from './permissions';
import { AuthContext, hasPermission } from './scope';

/**
 * Field-level permissions. A field listed here is stripped from responses (and exports)
 * unless the caller holds the permission - or it is their own record and `ownerCan` is true.
 */
export interface FieldRule {
  permission: PermissionKey;
  ownerCan?: boolean;
}

export const FIELD_RULES = {
  employee: {
    date_of_birth: { permission: 'employee.read_sensitive', ownerCan: true },
    gender: { permission: 'employee.read_sensitive', ownerCan: true },
    marital_status: { permission: 'employee.read_sensitive', ownerCan: true },
    current_address: { permission: 'employee.read_sensitive', ownerCan: true },
    permanent_address: { permission: 'employee.read_sensitive', ownerCan: true },
    personal_email: { permission: 'employee.read_sensitive', ownerCan: true },
    phone: { permission: 'employee.read_sensitive', ownerCan: true },
    pan_masked: { permission: 'employee.read_identifiers', ownerCan: true },
    uan_masked: { permission: 'employee.read_identifiers', ownerCan: true },
    bank_account_masked: { permission: 'employee.read_bank', ownerCan: true },
    bank_name: { permission: 'employee.read_bank', ownerCan: true },
    monthly_ctc: { permission: 'salary.read_assignment' },
    salary_structure: { permission: 'salary.read_assignment' },
  },
  candidate: {
    current_ctc: { permission: 'candidate.read_salary' },
    expected_ctc: { permission: 'candidate.read_salary' },
  },
} as const satisfies Record<string, Record<string, FieldRule>>;

export type FieldEntity = keyof typeof FIELD_RULES;

/** Returns a copy of `record` with every field the caller may not see removed. */
export function redact<T extends Record<string, unknown>>(
  ctx: AuthContext,
  entity: FieldEntity,
  record: T,
  opts: { isOwnRecord?: boolean } = {},
): Partial<T> {
  const rules = FIELD_RULES[entity] as Record<string, FieldRule>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const rule = rules[key];
    if (!rule) {
      out[key] = value;
      continue;
    }
    const ownerAllowed = opts.isOwnRecord === true && rule.ownerCan === true;
    if (ownerAllowed || hasPermission(ctx, rule.permission)) out[key] = value;
  }
  return out as Partial<T>;
}

/** Field names the caller may NOT see; saved views/exports/filters must refuse these. */
export function forbiddenFields(ctx: AuthContext, entity: FieldEntity, opts: { isOwnRecord?: boolean } = {}): string[] {
  const rules = FIELD_RULES[entity] as Record<string, FieldRule>;
  return Object.entries(rules)
    .filter(([, rule]) => !(opts.isOwnRecord && rule.ownerCan) && !hasPermission(ctx, rule.permission))
    .map(([field]) => field);
}

/** Mask an identifier for display: keep the last 4 characters. */
export function maskIdentifier(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}
