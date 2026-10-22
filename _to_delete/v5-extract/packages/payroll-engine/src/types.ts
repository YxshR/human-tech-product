/**
 * Payroll engine contract. Pure, deterministic, side-effect free: same input => same output.
 * All money crosses this boundary as DECIMAL STRINGS (e.g. "50000.00"). Never floats.
 *
 * The engine ships NO statutory content. PF/ESI/PT/TDS/LWF values arrive as reviewed,
 * versioned `Rule`s inside the input; the engine only knows how to apply generic rule shapes.
 */
export const ENGINE_VERSION = '0.1.0';

export type ComponentType = 'earning' | 'employee_deduction' | 'employer_contribution' | 'informational';
export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';

export interface Rounding {
  mode: RoundingMode;
  /** Decimal places of the final amount: 2 = paise, 0 = whole rupees. */
  places: 0 | 1 | 2;
}

export type ComponentMethod =
  /** Fixed monthly amount. */
  | { kind: 'fixed'; amount: string }
  /**
   * Percentage of other components. `basis: 'full'` (default) reads their full-month amounts and the
   * result is prorated like any other component; `basis: 'earned'` reads what was actually earned
   * after proration and is NOT prorated again.
   */
  | { kind: 'percent_of'; percentage: string; baseCodes: string[]; basis?: 'full' | 'earned' }
  /** Whatever remains of the monthly target so that earnings add up to it (e.g. special allowance). */
  | { kind: 'balance'; target: string }
  /** Defer to a reviewed statutory/company rule bound to this run. */
  | { kind: 'rule'; ruleId: string }
  /** Value supplied per employee per period (variable pay, overtime), already approved. */
  | { kind: 'input'; inputKey: string };

export interface ComponentDef {
  code: string;
  label: string;
  type: ComponentType;
  method: ComponentMethod;
  /** Scale by paid_days / working_days (LOP). Usually true for earnings, false for statutory fixed amounts. */
  prorate: boolean;
  rounding: Rounding;
  displayOrder: number;
  /** Version id of the component definition (for audit); optional in tests. */
  versionId?: string;
}

export type RuleDef =
  | {
      kind: 'percentage';
      rate: string; // e.g. "0.12" meaning 12%
      baseCodes: string[];
      /** Base is capped at this value (wage ceiling). */
      baseCeiling?: string;
      baseFloor?: string;
      /** Rule applies only while base <= this limit (eligibility threshold). */
      applyIfBaseAtMost?: string;
      /** Result capped at this value. */
      maxAmount?: string;
    }
  | {
      kind: 'slab';
      baseCodes: string[];
      /** Ascending, non-overlapping. `upTo` is inclusive; last slab may omit it. */
      slabs: Array<{ upTo?: string; amount: string }>;
    };

export interface Rule {
  id: string;
  /** e.g. pf | esi | professional_tax | tds | lwf | other */
  group: string;
  version: number;
  def: RuleDef;
}

export interface EmployeeInput {
  employeeId: string;
  /** Components that apply to this employee (already resolved from structure + overrides). */
  components: ComponentDef[];
  /** Days basis for proration. */
  workingDays: string;
  paidDays: string;
  /** Approved one-off adjustments: positive amounts, kind decides direction. */
  adjustments?: Array<{ id: string; componentCode: string; kind: 'earning' | 'deduction'; amount: string; reason: string }>;
  /** Per-period variable inputs referenced by `input` methods. */
  inputs?: Record<string, string>;
  salaryAssignmentId?: string;
  /** Optional hold: employee is calculated but flagged for review. */
  flags?: string[];
}

export interface RunInput {
  runId: string;
  periodCode: string;
  employees: EmployeeInput[];
  rules: Rule[];
}

export interface TraceStep {
  /** Human-readable explanation of how the figure was derived. */
  note: string;
  /** Inputs used, as decimal strings, for reproducibility. */
  values: Record<string, string>;
}

export interface Line {
  componentCode: string;
  label: string;
  type: ComponentType;
  method: ComponentMethod['kind'];
  amount: string;
  calculationBase?: string;
  appliedRate?: string;
  quantity?: string;
  ruleId?: string;
  versionId?: string;
  displayOrder: number;
  trace: TraceStep[];
}

export type ExceptionSeverity = 'blocking' | 'warning';

export interface CalcException {
  code: string;
  severity: ExceptionSeverity;
  message: string;
  employeeId?: string;
  details?: Record<string, string>;
}

export interface EmployeeResult {
  employeeId: string;
  status: 'calculated' | 'needs_review';
  grossEarnings: string;
  employeeDeductions: string;
  employerContributions: string;
  netPay: string;
  workingDays: string;
  paidDays: string;
  unpaidDays: string;
  lines: Line[];
}

export interface RunResult {
  engineVersion: string;
  runId: string;
  periodCode: string;
  /** SHA-256 of the canonical input; recomputing must give the same value. */
  inputHash: string;
  /** SHA-256 of the rules bound to the run. */
  ruleBundleHash: string;
  employees: EmployeeResult[];
  exceptions: CalcException[];
  totals: { gross: string; employeeDeductions: string; employerContributions: string; netPay: string };
}
