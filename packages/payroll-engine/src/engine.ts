import { canonical, sha256 } from './hash';
import { Dec, fmt, parse, round, sum, ZERO } from './money';
import {
  CalcException, ComponentDef, ENGINE_VERSION, EmployeeInput, EmployeeResult, Line, Rule, RuleDef, RunInput, RunResult, TraceStep,
} from './types';


interface Ctx {
  rules: Map<string, Rule>;
  exceptions: CalcException[];
}

/** Stable dependency order: a component is computed only after every code it reads. */
function orderComponents(components: ComponentDef[], rules: Map<string, Rule>, employeeId: string, ctx: Ctx): ComponentDef[] {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const deps = (c: ComponentDef): string[] => {
    switch (c.method.kind) {
      case 'percent_of': return c.method.baseCodes;
      case 'rule': return rules.get(c.method.ruleId)?.def.baseCodes ?? [];
      case 'balance': return components.filter((x) => x.type === 'earning' && x.code !== c.code && x.method.kind !== 'balance').map((x) => x.code);
      default: return [];
    }
  };
  const sorted: ComponentDef[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (c: ComponentDef, path: string[]): boolean => {
    if (state.get(c.code) === 'done') return true;
    if (state.get(c.code) === 'visiting') {
      ctx.exceptions.push({ code: 'CIRCULAR_COMPONENT', severity: 'blocking', employeeId,
        message: `Components depend on each other in a loop: ${[...path, c.code].join(' -> ')}` });
      return false;
    }
    state.set(c.code, 'visiting');
    for (const d of deps(c)) {
      const dep = byCode.get(d);
      if (!dep) {
        ctx.exceptions.push({ code: 'UNKNOWN_BASE_COMPONENT', severity: 'blocking', employeeId,
          message: `Component ${c.code} depends on ${d}, which is not part of this employee's structure`, details: { component: c.code, missing: d } });
        continue;
      }
      if (!visit(dep, [...path, c.code])) return false;
    }
    state.set(c.code, 'done');
    sorted.push(c);
    return true;
  };
  // Deterministic regardless of input array order.
  const start = [...components].sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));
  for (const c of start) if (!visit(c, [])) return [];
  return sorted;
}

function applyRule(def: RuleDef, base: Dec, trace: TraceStep[]): { amount: Dec; rate?: string } {
  if (def.kind === 'percentage') {
    let b = base;
    if (def.applyIfBaseAtMost !== undefined && b.gt(parse(def.applyIfBaseAtMost, 'applyIfBaseAtMost'))) {
      trace.push({ note: 'rule not applicable: base above eligibility limit', values: { base: fmt(b, 4), limit: def.applyIfBaseAtMost } });
      return { amount: ZERO, rate: def.rate };
    }
    if (def.baseFloor !== undefined && b.lt(parse(def.baseFloor))) b = parse(def.baseFloor);
    if (def.baseCeiling !== undefined && b.gt(parse(def.baseCeiling))) {
      trace.push({ note: 'base capped at wage ceiling', values: { base: fmt(b, 4), ceiling: def.baseCeiling } });
      b = parse(def.baseCeiling);
    }
    let amt = b.times(parse(def.rate, 'rate'));
    if (def.maxAmount !== undefined && amt.gt(parse(def.maxAmount))) {
      trace.push({ note: 'amount capped at maximum', values: { uncapped: fmt(amt, 4), max: def.maxAmount } });
      amt = parse(def.maxAmount);
    }
    return { amount: amt, rate: def.rate };
  }
  for (const s of def.slabs) {
    if (s.upTo === undefined || base.lte(parse(s.upTo, 'slab.upTo'))) {
      trace.push({ note: 'slab matched', values: { base: fmt(base, 4), upTo: s.upTo ?? 'unbounded', amount: s.amount } });
      return { amount: parse(s.amount, 'slab.amount') };
    }
  }
  return { amount: ZERO };
}

function calcEmployee(emp: EmployeeInput, ctx: Ctx): EmployeeResult {
  const working = parse(emp.workingDays, 'workingDays');
  const paid = parse(emp.paidDays, 'paidDays');
  const startEx = ctx.exceptions.length;

  if (working.lte(0)) ctx.exceptions.push({ code: 'NO_WORKING_DAYS', severity: 'blocking', employeeId: emp.employeeId, message: 'Working days must be greater than zero' });
  if (paid.lt(0) || paid.gt(working)) ctx.exceptions.push({ code: 'PAID_DAYS_OUT_OF_RANGE', severity: 'blocking', employeeId: emp.employeeId,
    message: `Paid days ${paid.toString()} must be between 0 and working days ${working.toString()}`, details: { paidDays: paid.toString(), workingDays: working.toString() } });
  if (working.gt(0) && paid.eq(0)) ctx.exceptions.push({ code: 'ZERO_PAID_DAYS', severity: 'warning', employeeId: emp.employeeId, message: 'No paid days in this period, so the pay will be zero. Check attendance and leave.', details: { workingDays: working.toString() } });
  if (emp.components.length === 0) ctx.exceptions.push({ code: 'NO_SALARY_STRUCTURE', severity: 'blocking', employeeId: emp.employeeId, message: 'Employee has no salary components for this period' });

  const factor = working.gt(0) && paid.gte(0) && paid.lte(working) ? paid.div(working) : ZERO;
  const ordered = orderComponents(emp.components, ctx.rules, emp.employeeId, ctx);
  const earned = new Map<string, Dec>(); // after proration + rounding: what the employee actually gets
  const full = new Map<string, Dec>(); // full-month figure (rounded), before proration
  const lines: Line[] = [];

  for (const c of ordered) {
    const trace: TraceStep[] = [];
    let raw: Dec = ZERO;
    let base: Dec | undefined;
    let rate: string | undefined;
    let ruleId: string | undefined;
    let prorate = c.prorate;

    switch (c.method.kind) {
      case 'fixed':
        raw = parse(c.method.amount, `${c.code}.amount`);
        trace.push({ note: 'fixed amount', values: { amount: c.method.amount } });
        break;
      case 'input': {
        const v = emp.inputs?.[c.method.inputKey];
        if (v === undefined) {
          ctx.exceptions.push({ code: 'MISSING_INPUT', severity: 'blocking', employeeId: emp.employeeId, message: `Input ${c.method.inputKey} for ${c.code} was not supplied`, details: { inputKey: c.method.inputKey } });
        } else raw = parse(v, c.method.inputKey);
        trace.push({ note: 'variable input', values: { inputKey: c.method.inputKey, value: v ?? 'missing' } });
        break;
      }
      case 'percent_of': {
        const useEarned = c.method.basis === 'earned';
        const src = useEarned ? earned : full;
        base = sum(c.method.baseCodes.map((b) => src.get(b) ?? ZERO));
        rate = c.method.percentage;
        raw = base.times(parse(c.method.percentage, `${c.code}.percentage`)).div(100);
        if (useEarned) prorate = false;
        trace.push({ note: `percentage of ${useEarned ? 'earned' : 'full-month'} base`, values: { base: fmt(base, 4), percentage: c.method.percentage, components: c.method.baseCodes.join('+') } });
        break;
      }
      case 'balance': {
        const others = sum(ordered.filter((x) => x.type === 'earning' && x.method.kind !== 'balance').map((x) => full.get(x.code) ?? ZERO));
        base = others;
        raw = parse(c.method.target, `${c.code}.target`).minus(others);
        if (raw.lt(0)) {
          ctx.exceptions.push({ code: 'BALANCE_NEGATIVE', severity: 'blocking', employeeId: emp.employeeId,
            message: `Fixed components exceed the monthly target by ${fmt(raw.neg())}; ${c.code} cannot be negative`, details: { target: c.method.target, fixedTotal: fmt(others) } });
          raw = ZERO;
        }
        trace.push({ note: 'balance of target after other earnings', values: { target: c.method.target, otherEarnings: fmt(others, 4) } });
        break;
      }
      case 'rule': {
        const rule = ctx.rules.get(c.method.ruleId);
        if (!rule) {
          ctx.exceptions.push({ code: 'RULE_NOT_BOUND', severity: 'blocking', employeeId: emp.employeeId, message: `Rule ${c.method.ruleId} for ${c.code} is not bound to this run`, details: { ruleId: c.method.ruleId } });
          break;
        }
        ruleId = rule.id;
        // Statutory rules act on wages actually earned, so they are never prorated again.
        base = sum(rule.def.baseCodes.map((b) => earned.get(b) ?? ZERO));
        const res = applyRule(rule.def, base, trace);
        raw = res.amount;
        rate = res.rate;
        prorate = false;
        trace.push({ note: `rule ${rule.group} v${rule.version}`, values: { base: fmt(base, 4), result: fmt(raw, 4) } });
        break;
      }
    }

    const fullAmount = round(raw, c.rounding);
    let amount = raw;
    if (prorate) {
      amount = raw.times(factor);
      trace.push({ note: 'prorated for paid days', values: { paidDays: paid.toString(), workingDays: working.toString(), factor: factor.toFixed(6) } });
    }
    amount = round(amount, c.rounding);
    if (amount.lt(0)) {
      ctx.exceptions.push({ code: 'NEGATIVE_COMPONENT', severity: 'blocking', employeeId: emp.employeeId, message: `${c.code} computed a negative amount`, details: { component: c.code, amount: fmt(amount) } });
      amount = ZERO;
    }
    earned.set(c.code, amount);
    full.set(c.code, fullAmount);
    lines.push({
      componentCode: c.code, label: c.label, type: c.type, method: c.method.kind, amount: fmt(amount),
      calculationBase: base ? fmt(base) : undefined, appliedRate: rate, ruleId, versionId: c.versionId,
      displayOrder: c.displayOrder, trace,
    });
  }

  // One-off adjustments (already approved upstream). They become their own lines.
  for (const a of [...(emp.adjustments ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
    const amt = parse(a.amount, `adjustment ${a.id}`);
    if (amt.lte(0)) {
      ctx.exceptions.push({ code: 'BAD_ADJUSTMENT', severity: 'blocking', employeeId: emp.employeeId, message: `Adjustment ${a.id} must be positive` });
      continue;
    }
    lines.push({
      componentCode: a.componentCode, label: `Adjustment: ${a.reason}`, type: a.kind === 'earning' ? 'earning' : 'employee_deduction',
      method: 'fixed', amount: fmt(amt), displayOrder: 9000 + lines.length,
      trace: [{ note: 'approved adjustment', values: { adjustmentId: a.id, amount: a.amount } }],
    });
  }

  const total = (t: Line['type']): Dec => sum(lines.filter((l) => l.type === t).map((l) => parse(l.amount)));
  const gross = total('earning');
  const deductions = total('employee_deduction');
  const employer = total('employer_contribution');
  const net = gross.minus(deductions);
  if (net.lt(0)) {
    ctx.exceptions.push({ code: 'NEGATIVE_NET_PAY', severity: 'blocking', employeeId: emp.employeeId, message: `Deductions (${fmt(deductions)}) exceed earnings (${fmt(gross)})`, details: { gross: fmt(gross), deductions: fmt(deductions) } });
  }
  const blocked = ctx.exceptions.slice(startEx).some((e) => e.severity === 'blocking') || (emp.flags?.length ?? 0) > 0;
  return {
    employeeId: emp.employeeId,
    status: blocked ? 'needs_review' : 'calculated',
    grossEarnings: fmt(gross), employeeDeductions: fmt(deductions), employerContributions: fmt(employer), netPay: fmt(net),
    workingDays: working.toString(), paidDays: paid.toString(), unpaidDays: working.minus(paid).toString(),
    lines: lines.sort((a, b) => a.displayOrder - b.displayOrder || a.componentCode.localeCompare(b.componentCode)),
  };
}

export function calculateRun(input: RunInput): RunResult {
  const seen = new Set<string>();
  for (const e of input.employees) {
    if (seen.has(e.employeeId)) throw new Error(`duplicate employee in run input: ${e.employeeId}`);
    seen.add(e.employeeId);
  }
  const rules = new Map(input.rules.map((r) => [r.id, r]));
  const ctx: Ctx = { rules, exceptions: [] };
  const employees = [...input.employees]
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
    .map((e) => calcEmployee(e, ctx));

  const col = (k: 'grossEarnings' | 'employeeDeductions' | 'employerContributions' | 'netPay'): string =>
    fmt(sum(employees.map((e) => parse(e[k]))));
  return {
    engineVersion: ENGINE_VERSION,
    runId: input.runId,
    periodCode: input.periodCode,
    inputHash: sha256(canonical({ ...input, employees: [...input.employees].sort((a, b) => a.employeeId.localeCompare(b.employeeId)) })),
    ruleBundleHash: sha256(canonical([...input.rules].sort((a, b) => a.id.localeCompare(b.id)))),
    employees,
    exceptions: ctx.exceptions,
    totals: { gross: col('grossEarnings'), employeeDeductions: col('employeeDeductions'), employerContributions: col('employerContributions'), netPay: col('netPay') },
  };
}

