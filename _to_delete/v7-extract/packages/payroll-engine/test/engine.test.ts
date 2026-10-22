import { describe, expect, it } from 'vitest';
import { ComponentDef, EmployeeInput, Rule, RunInput, calculateRun } from '../src';

const r2 = { mode: 'half_up', places: 2 } as const;
const comp = (c: Partial<ComponentDef> & Pick<ComponentDef, 'code' | 'type' | 'method'>): ComponentDef => ({
  label: c.code, prorate: c.type === 'earning', rounding: r2, displayOrder: 10, ...c,
});

const structure: ComponentDef[] = [
  comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '25000.00' }, displayOrder: 1 }),
  comp({ code: 'HRA', type: 'earning', method: { kind: 'percent_of', percentage: '40', baseCodes: ['BASIC'] }, displayOrder: 2 }),
  comp({ code: 'SPECIAL', type: 'earning', method: { kind: 'balance', target: '50000.00' }, displayOrder: 3 }),
  comp({ code: 'EE_PF', type: 'employee_deduction', method: { kind: 'rule', ruleId: 'r-pf-ee' }, displayOrder: 20 }),
  comp({ code: 'ER_PF', type: 'employer_contribution', method: { kind: 'rule', ruleId: 'r-pf-er' }, displayOrder: 30 }),
];
// ILLUSTRATIVE test rules only. The product ships with no statutory content.
const rules: Rule[] = [
  { id: 'r-pf-ee', group: 'test', version: 1, def: { kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'], baseCeiling: '15000' } },
  { id: 'r-pf-er', group: 'test', version: 1, def: { kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'], baseCeiling: '15000' } },
];
const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'e1', components: structure, workingDays: '30', paidDays: '30', ...over,
});
const run = (employees: EmployeeInput[], r = rules): RunInput => ({ runId: 'run1', periodCode: '2030-04', employees, rules: r });

describe('golden: full attendance', () => {
  const res = calculateRun(run([emp()]));
  const e = res.employees[0]!;
  it('adds up to the monthly target', () => {
    expect(e.lines.map((l) => [l.componentCode, l.amount])).toEqual([
      ['BASIC', '25000.00'], ['HRA', '10000.00'], ['SPECIAL', '15000.00'], ['EE_PF', '1800.00'], ['ER_PF', '1800.00'],
    ]);
    expect(e.grossEarnings).toBe('50000.00');
    expect(e.employeeDeductions).toBe('1800.00');
    expect(e.employerContributions).toBe('1800.00');
    expect(e.netPay).toBe('48200.00');
    expect(e.status).toBe('calculated');
    expect(res.exceptions).toEqual([]);
  });
  it('every line carries a trace', () => {
    for (const l of e.lines) expect(l.trace.length).toBeGreaterThan(0);
  });
});

describe('golden: loss of pay', () => {
  const res = calculateRun(run([emp({ paidDays: '24' })]));
  const e = res.employees[0]!;
  it('prorates earnings; gross is exactly 24/30 of target', () => {
    expect(e.grossEarnings).toBe('40000.00');
    expect(e.unpaidDays).toBe('6');
    expect(e.lines.find((l) => l.componentCode === 'BASIC')!.amount).toBe('20000.00');
    expect(e.lines.find((l) => l.componentCode === 'HRA')!.amount).toBe('8000.00');
    expect(e.lines.find((l) => l.componentCode === 'SPECIAL')!.amount).toBe('12000.00');
  });
  it('statutory rule acts on earned wages with the ceiling', () => {
    expect(e.lines.find((l) => l.componentCode === 'EE_PF')!.amount).toBe('1800.00'); // 20000 capped at 15000 * 12%
  });
});

describe('golden: rounding and awkward fractions', () => {
  it('half-up on paise, balance still reconciles to target at full attendance', () => {
    const odd = [
      comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '33333.33' }, displayOrder: 1 }),
      comp({ code: 'HRA', type: 'earning', method: { kind: 'percent_of', percentage: '37.5', baseCodes: ['BASIC'] }, displayOrder: 2 }),
      comp({ code: 'SPECIAL', type: 'earning', method: { kind: 'balance', target: '70000.00' }, displayOrder: 3 }),
    ];
    const e = calculateRun(run([emp({ components: odd })])).employees[0]!;
    expect(e.lines.find((l) => l.componentCode === 'HRA')!.amount).toBe('12500.00'); // 12499.99875 rounds up to the paisa
    expect(e.grossEarnings).toBe('70000.00');
  });
  it('7 paid of 31 days, no drift: gross equals rounded proration of components', () => {
    const e = calculateRun(run([emp({ workingDays: '31', paidDays: '7' })])).employees[0]!;
    const sum = e.lines.filter((l) => l.type === 'earning').reduce((a, l) => a + Number(l.amount) * 100, 0);
    expect(Math.round(sum)).toBe(Number(e.grossEarnings) * 100);
  });
  it('whole-rupee rounding mode', () => {
    const c = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '1000.00' }, rounding: { mode: 'half_up', places: 0 } })];
    const e = calculateRun(run([emp({ components: c, workingDays: '30', paidDays: '29' })])).employees[0]!;
    expect(e.lines[0]!.amount).toBe('967.00'); // 966.666..
  });
  it('half-even rounds .5 to even', () => {
    const c = [comp({ code: 'A', type: 'earning', prorate: false, method: { kind: 'fixed', amount: '10.125' }, rounding: { mode: 'half_even', places: 2 } })];
    expect(calculateRun(run([emp({ components: c })])).employees[0]!.lines[0]!.amount).toBe('10.12');
  });
});

describe('slabs and eligibility', () => {
  const slabRule: Rule = { id: 's', group: 'test', version: 1, def: { kind: 'slab', baseCodes: ['BASIC'], slabs: [{ upTo: '10000', amount: '0' }, { upTo: '20000', amount: '150' }, { amount: '200' }] } };
  const slabComp = comp({ code: 'PT', type: 'employee_deduction', method: { kind: 'rule', ruleId: 's' }, displayOrder: 20 });
  it.each([['9000', '0.00'], ['10000', '0.00'], ['10001', '150.00'], ['20000', '150.00'], ['20001', '200.00']])('base %s => %s', (basic, expected) => {
    const comps = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: basic }, displayOrder: 1 }), slabComp];
    const e = calculateRun(run([emp({ components: comps })], [slabRule])).employees[0]!;
    expect(e.lines.find((l) => l.componentCode === 'PT')!.amount).toBe(expected);
  });
  it('eligibility limit switches a rule off above the threshold', () => {
    const r: Rule = { id: 'esi', group: 'test', version: 1, def: { kind: 'percentage', rate: '0.0075', baseCodes: ['BASIC'], applyIfBaseAtMost: '21000' } };
    const mk = (b: string) => [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: b }, displayOrder: 1 }), comp({ code: 'ESI', type: 'employee_deduction', method: { kind: 'rule', ruleId: 'esi' }, displayOrder: 20 })];
    expect(calculateRun(run([emp({ components: mk('21000.00') })], [r])).employees[0]!.lines[1]!.amount).toBe('157.50');
    expect(calculateRun(run([emp({ components: mk('21000.01') })], [r])).employees[0]!.lines[1]!.amount).toBe('0.00');
  });
});

describe('adjustments and inputs', () => {
  it('adds approved adjustments as separate, explained lines', () => {
    const e = calculateRun(run([emp({ adjustments: [
      { id: 'a2', componentCode: 'BONUS', kind: 'earning', amount: '1000.00', reason: 'Diwali' },
      { id: 'a1', componentCode: 'ADV', kind: 'deduction', amount: '500.00', reason: 'Advance recovery' },
    ] })])).employees[0]!;
    expect(e.grossEarnings).toBe('51000.00');
    expect(e.employeeDeductions).toBe('2300.00');
    expect(e.netPay).toBe('48700.00');
    expect(e.lines.filter((l) => l.label.startsWith('Adjustment')).length).toBe(2);
  });
  it('variable input component reads supplied value, flags when missing', () => {
    const c = [comp({ code: 'OT', type: 'earning', prorate: false, method: { kind: 'input', inputKey: 'ot_amount' } })];
    expect(calculateRun(run([emp({ components: c, inputs: { ot_amount: '1234.50' } })])).employees[0]!.grossEarnings).toBe('1234.50');
    const bad = calculateRun(run([emp({ components: c })]));
    expect(bad.exceptions[0]!.code).toBe('MISSING_INPUT');
    expect(bad.employees[0]!.status).toBe('needs_review');
  });
});

describe('exceptions are blocking and explicit', () => {
  const codes = (r: ReturnType<typeof calculateRun>) => r.exceptions.map((e) => e.code);
  it('paid days above working days', () => expect(codes(calculateRun(run([emp({ paidDays: '31' })])))).toContain('PAID_DAYS_OUT_OF_RANGE'));
  it('zero paid days is flagged as a warning, not blocking', () => { const r = calculateRun(run([emp({ paidDays: '0' })])); const e = r.exceptions.find((x) => x.code === 'ZERO_PAID_DAYS'); expect(e?.severity).toBe('warning'); });
  it('zero working days', () => expect(codes(calculateRun(run([emp({ workingDays: '0', paidDays: '0' })])))).toContain('NO_WORKING_DAYS'));
  it('no structure', () => expect(codes(calculateRun(run([emp({ components: [] })])))).toContain('NO_SALARY_STRUCTURE'));
  it('rule not bound', () => expect(codes(calculateRun(run([emp()], [])))).toContain('RULE_NOT_BOUND'));
  it('unknown base component', () => {
    const c = [comp({ code: 'HRA', type: 'earning', method: { kind: 'percent_of', percentage: '40', baseCodes: ['NOPE'] } })];
    expect(codes(calculateRun(run([emp({ components: c })])))).toContain('UNKNOWN_BASE_COMPONENT');
  });
  it('circular dependency', () => {
    const c = [
      comp({ code: 'A', type: 'earning', method: { kind: 'percent_of', percentage: '10', baseCodes: ['B'] } }),
      comp({ code: 'B', type: 'earning', method: { kind: 'percent_of', percentage: '10', baseCodes: ['A'] } }),
    ];
    expect(codes(calculateRun(run([emp({ components: c })])))).toContain('CIRCULAR_COMPONENT');
  });
  it('balance cannot go negative', () => {
    const c = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '60000' } }), comp({ code: 'SP', type: 'earning', method: { kind: 'balance', target: '50000' } })];
    expect(codes(calculateRun(run([emp({ components: c })])))).toContain('BALANCE_NEGATIVE');
  });
  it('deductions above earnings => negative net blocked', () => {
    const c = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '100' } }), comp({ code: 'LOAN', type: 'employee_deduction', method: { kind: 'fixed', amount: '500' } })];
    const r = calculateRun(run([emp({ components: c })]));
    expect(codes(r)).toContain('NEGATIVE_NET_PAY');
    expect(r.employees[0]!.status).toBe('needs_review');
  });
  it('rejects malformed money strings instead of guessing', () => {
    const c = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '1e5' } })];
    expect(() => calculateRun(run([emp({ components: c })]))).toThrow(/plain decimal/);
    const c2 = [comp({ code: 'BASIC', type: 'earning', method: { kind: 'fixed', amount: '1,000' } })];
    expect(() => calculateRun(run([emp({ components: c2 })]))).toThrow(/plain decimal/);
  });
  it('duplicate employees in input are refused', () => {
    expect(() => calculateRun(run([emp(), emp()]))).toThrow(/duplicate employee/);
  });
});

describe('determinism and invariants', () => {
  it('same input => byte-identical output and hashes', () => {
    const a = calculateRun(run([emp(), emp({ employeeId: 'e2', paidDays: '20' })]));
    const b = calculateRun(run([emp(), emp({ employeeId: 'e2', paidDays: '20' })]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is independent of employee and component ordering', () => {
    const a = calculateRun(run([emp(), emp({ employeeId: 'e2', paidDays: '20' })]));
    const b = calculateRun(run([emp({ employeeId: 'e2', paidDays: '20', components: [...structure].reverse() }), emp({ components: [...structure].reverse() })]));
    expect(b.totals).toEqual(a.totals);
    expect(b.employees.map((e) => e.netPay)).toEqual(a.employees.map((e) => e.netPay));
  });
  it('changing any input or rule changes the hashes', () => {
    const a = calculateRun(run([emp()]));
    expect(calculateRun(run([emp({ paidDays: '29' })])).inputHash).not.toBe(a.inputHash);
    const r2 = rules.map((r) => ({ ...r, version: 2 }));
    expect(calculateRun(run([emp()], r2)).ruleBundleHash).not.toBe(a.ruleBundleHash);
  });
  it('run totals equal the sum of employees and net = gross - deductions for everyone', () => {
    const r = calculateRun(run([emp(), emp({ employeeId: 'e2', paidDays: '17' }), emp({ employeeId: 'e3', workingDays: '31', paidDays: '9' })]));
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(r.employees.reduce((a, e) => a + cents(e.grossEarnings), 0)).toBe(cents(r.totals.gross));
    expect(r.employees.reduce((a, e) => a + cents(e.netPay), 0)).toBe(cents(r.totals.netPay));
    for (const e of r.employees) expect(cents(e.netPay)).toBe(cents(e.grossEarnings) - cents(e.employeeDeductions));
  });
  it('property: for 500 pseudo-random attendances, lines always reconcile to employee totals', () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    for (let i = 0; i < 500; i++) {
      const wd = 28 + rnd(4);
      const pd = Math.min(wd, rnd(wd * 2 + 1) / 2);
      const e = calculateRun(run([emp({ workingDays: String(wd), paidDays: String(pd) })])).employees[0]!;
      const cents = (s: string) => Math.round(Number(s) * 100);
      const g = e.lines.filter((l) => l.type === 'earning').reduce((a, l) => a + cents(l.amount), 0);
      const d = e.lines.filter((l) => l.type === 'employee_deduction').reduce((a, l) => a + cents(l.amount), 0);
      expect(g).toBe(cents(e.grossEarnings));
      expect(cents(e.netPay)).toBe(g - d);
      expect(cents(e.grossEarnings)).toBeLessThanOrEqual(5000000);
    }
  });
});
