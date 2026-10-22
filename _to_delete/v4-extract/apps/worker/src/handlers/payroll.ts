import { createHash, randomUUID } from 'node:crypto';
import { PermanentJobError } from '@humantech/jobs';
import { z } from 'zod';
import { renderPayslipPdf } from '../payslip-pdf';
import type { Register } from './types';

const finalized = z.object({ periodId: z.string().uuid().optional(), revision: z.number().int().optional() });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodLabel = (code: string): string => { const m = /^(\d{4})-(\d{2})$/.exec(code); return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : code; };

/** After a payroll run is finalised: render one PDF per payslip, store it privately and tell the employee. Re-runnable. */
export const registerPayroll: Register = (runner, deps) => runner
  .register('payroll.finalized', async (job, ctx) => {
    if (!finalized.safeParse(job.payload).success) throw new PermanentJobError('invalid_payload', 'payload is invalid');
    const todo = await ctx.tx(async (c) => {
      const run = (await c.query<{ status: string; period_code: string; company: string }>(
        `SELECT r.status, per.period_code, t.display_name AS company FROM payroll_runs r
           JOIN payroll_periods per ON per.tenant_id=r.tenant_id AND per.id=r.payroll_period_id JOIN tenants t ON t.id=r.tenant_id
          WHERE r.tenant_id=$1 AND r.id=$2`, [job.tenantId, job.aggregateId])).rows[0];
      if (!run) throw new PermanentJobError('run_missing', 'payroll run not found');
      if (!['locked', 'payslips_generated'].includes(run.status)) throw new PermanentJobError('run_not_final', `run is ${run.status}`);
      const slips = (await c.query(
        `SELECT s.id, s.revision, s.issued_at, e.employee_number, e.user_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
                i.id AS item_id, i.working_days::text, i.paid_days::text, i.unpaid_days::text, i.gross_earnings::text, i.employee_deductions::text, i.net_pay::text
           FROM payslips s JOIN payroll_run_items i ON i.tenant_id=s.tenant_id AND i.id=s.payroll_run_item_id
           JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
          WHERE s.tenant_id=$1 AND i.payroll_run_id=$2 AND s.status IN ('pending','failed') ORDER BY e.employee_number`, [job.tenantId, job.aggregateId])).rows;
      const lines = slips.length ? (await c.query(
        `SELECT payroll_run_item_id, component_label_snapshot AS label, component_type, amount::text FROM payroll_line_items
          WHERE tenant_id=$1 AND payroll_run_item_id = ANY($2::uuid[]) AND component_type IN ('earning','employee_deduction') ORDER BY display_order, component_code`,
        [job.tenantId, slips.map((s) => s.item_id)])).rows : [];
      return { run, slips, lines };
    });

    let failed = 0;
    for (const s of todo.slips) {
      try {
        const mine = todo.lines.filter((l) => l.payroll_run_item_id === s.item_id);
        const pdf = await renderPayslipPdf({
          companyName: todo.run.company, periodLabel: periodLabel(todo.run.period_code), employeeName: s.employee_name, employeeNumber: s.employee_number, revision: s.revision,
          workingDays: s.working_days ?? '0', paidDays: s.paid_days ?? '0', unpaidDays: s.unpaid_days ?? '0',
          earnings: mine.filter((l) => l.component_type === 'earning').map((l) => ({ label: l.label, amount: l.amount })),
          deductions: mine.filter((l) => l.component_type === 'employee_deduction').map((l) => ({ label: l.label, amount: l.amount })),
          grossEarnings: s.gross_earnings, totalDeductions: s.employee_deductions, netPay: s.net_pay, issuedOn: (s.issued_at as Date).toISOString().slice(0, 10),
        });
        const fileId = randomUUID();
        const key = `${job.tenantId}/payslip/${fileId}`;
        await deps.storage.put(key, pdf, 'application/pdf');
        await ctx.tx(async (c) => {
          await c.query(
            `INSERT INTO stored_files (id, tenant_id, purpose, object_key, original_filename, content_type, size_bytes, checksum_sha256, status, scanned_at)
             VALUES ($1,$2,'payslip',$3,$4,'application/pdf',$5,$6,'clean',now())`,
            [fileId, job.tenantId, key, `payslip-${todo.run.period_code}-${s.employee_number}.pdf`, pdf.length, createHash('sha256').update(pdf).digest('hex')]);
          await c.query(`UPDATE payslips SET file_id=$3, status='ready', generated_at=now() WHERE tenant_id=$1 AND id=$2`, [job.tenantId, s.id, fileId]);
          if (s.user_id) {
            await c.query(
              `INSERT INTO notifications (tenant_id, recipient_user_id, event_key, title, body, data, dedupe_key) VALUES ($1,$2,'payslip.ready',$3,$4,$5,$6)
               ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
              [job.tenantId, s.user_id, `Your ${periodLabel(todo.run.period_code)} payslip is ready`, null, JSON.stringify({ payslipId: s.id }), `payslip-ready:${s.id}`]);
          }
        });
      } catch (e) {
        failed++;
        ctx.log('payslip failed', { payslipId: s.id, error: (e as Error).message });
        await ctx.tx((c) => c.query(`UPDATE payslips SET status='failed' WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [job.tenantId, s.id])).catch(() => undefined);
      }
    }
    if (failed > 0) throw new Error(`${failed} payslip(s) failed to render; will retry`);
    ctx.log('payslips generated', { count: todo.slips.length });
  })
  // Platform staff act on this through the admin CLI (`activate-payroll`); nothing to do automatically, but it must not dead-letter.
  .register('payroll.activation_requested', async (job, ctx) => { ctx.log('payroll activation requested', { tenantId: job.tenantId }); });
