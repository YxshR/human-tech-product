-- 0010_payroll_workflow.sql
-- Changes needed by the payroll API workflow.
--
-- (1) Salary assignments: a PROPOSED (pending) assignment must be allowed to coexist with the approved one it will
--     replace. Overlap is now forbidden among APPROVED rows only; a partial unique index allows one pending
--     proposal per employee. On approval the API ends the previous approved row the day before.
-- (2) Pay groups: how paid days are derived (from attendance, or full pay except approved unpaid leave).
-- (3) A tenant-visible record that payroll activation was requested (activation itself stays platform-only).

ALTER TABLE employee_salary_assignments DROP CONSTRAINT ex_salary_assignment_no_overlap;
ALTER TABLE employee_salary_assignments ADD CONSTRAINT ex_salary_assignment_no_overlap EXCLUDE USING gist (
  tenant_id WITH =, employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
) WHERE (superseded_at IS NULL AND approval_status = 'approved');
CREATE UNIQUE INDEX uq_salary_assignment_one_pending ON employee_salary_assignments (tenant_id, employee_id)
  WHERE approval_status = 'pending' AND superseded_at IS NULL;

ALTER TABLE pay_groups ADD COLUMN attendance_source text NOT NULL DEFAULT 'attendance'
  CHECK (attendance_source IN ('attendance', 'full_pay'));
COMMENT ON COLUMN pay_groups.attendance_source IS
  'attendance: paid days come from locked attendance; full_pay: every calendar day is paid except approved unpaid leave';

ALTER TABLE tenants ADD COLUMN payroll_activation_requested_at timestamptz;
GRANT UPDATE (payroll_activation_requested_at) ON tenants TO humantech_app;
