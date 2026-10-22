-- 0004_time_and_leave.sql
-- Shifts, holidays, attendance (+ raw events and corrections), leave policies, requests and
-- an append-only leave ledger with concurrency-safe balance protection.
--
-- Payroll-cutoff rule: once a payroll period's attendance is locked
-- (payroll_periods.attendance_locked_at, added in 0005) attendance rows inside that period
-- are frozen by a trigger; later fixes must flow through a controlled payroll adjustment.

-- -----------------------------------------------------------------------------
-- Calendars and shifts
-- -----------------------------------------------------------------------------
CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid,                            -- NULL = applies to the whole tenant
  holiday_date date NOT NULL,
  name text NOT NULL,
  is_optional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_holidays_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX uq_holidays_scope_date ON holidays
  (tenant_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date, name);
CREATE INDEX ix_holidays_date ON holidays (tenant_id, holiday_date);

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  crosses_midnight boolean GENERATED ALWAYS AS (end_time <= start_time) STORED,
  grace_minutes integer NOT NULL DEFAULT 0 CHECK (grace_minutes >= 0),
  half_day_minutes integer NOT NULL DEFAULT 240 CHECK (half_day_minutes > 0),
  full_day_minutes integer NOT NULL DEFAULT 480 CHECK (full_day_minutes > 0),
  weekly_off_days smallint[] NOT NULL DEFAULT '{0}',     -- 0 = Sunday .. 6 = Saturday
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shifts_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shifts_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT ck_shift_thresholds CHECK (half_day_minutes <= full_day_minutes),
  CONSTRAINT ck_shift_weekly_off CHECK (weekly_off_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);

CREATE TABLE shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  superseded_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shift_assignments_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id),
  CONSTRAINT ck_shift_assignment_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_shift_assignment_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (superseded_at IS NULL)
);

-- Versioned, effective-dated attendance rules. Rules are DATA, not frontend conditionals.
CREATE TABLE attendance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  late_after_grace_counts_as_late boolean NOT NULL DEFAULT true,
  late_marks_per_half_day integer CHECK (late_marks_per_half_day > 0),
  missing_punch_policy text NOT NULL DEFAULT 'flag' CHECK (missing_punch_policy IN ('flag', 'half_day', 'absent')),
  allow_employee_checkin boolean NOT NULL DEFAULT false,
  correction_window_days integer NOT NULL DEFAULT 7 CHECK (correction_window_days >= 0),
  overtime_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_policies_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_attendance_policies_version UNIQUE (tenant_id, name, version),
  CONSTRAINT ck_attendance_policy_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_attendance_policy_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);

-- -----------------------------------------------------------------------------
-- Attendance
-- -----------------------------------------------------------------------------
CREATE TABLE attendance_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  work_date date NOT NULL,                     -- in the work-location time zone
  shift_assignment_id uuid,
  attendance_status text NOT NULL CHECK (attendance_status IN
    ('present', 'absent', 'half_day', 'leave', 'holiday', 'weekly_off', 'work_from_home', 'not_marked')),
  check_in_at timestamptz,
  check_out_at timestamptz,
  worked_minutes integer CHECK (worked_minutes IS NULL OR worked_minutes >= 0),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  overtime_minutes integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  paid_day_fraction numeric(4, 3) NOT NULL DEFAULT 1.000 CHECK (paid_day_fraction BETWEEN 0 AND 1),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'device_import', 'file_import', 'employee_checkin', 'system')),
  approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  correction_version integer NOT NULL DEFAULT 0 CHECK (correction_version >= 0),
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_day_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_attendance_day_employee_date UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_assignment_id) REFERENCES shift_assignments (tenant_id, id),
  CONSTRAINT ck_attendance_punches CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at >= check_in_at)
);
CREATE INDEX ix_attendance_tenant_date ON attendance_days (tenant_id, work_date DESC, attendance_status);
CREATE INDEX ix_attendance_employee_date ON attendance_days (tenant_id, employee_id, work_date DESC);
CREATE TRIGGER trg_attendance_days_touch BEFORE UPDATE ON attendance_days FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Raw punches, append-only: the day record is derived from these and can be re-derived.
CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('device_import', 'file_import', 'employee_checkin', 'manual')),
  device_reference text,
  import_job_id uuid,                          -- FK added in 0006
  idempotency_key text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_events_idempotency UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX ix_attendance_events_employee_time ON attendance_events (tenant_id, employee_id, occurred_at DESC);

CREATE TABLE attendance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  attendance_day_id uuid NOT NULL,
  previous_values jsonb NOT NULL,
  requested_values jsonb NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_correction_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, attendance_day_id) REFERENCES attendance_days (tenant_id, id),
  -- Nobody approves their own correction.
  CONSTRAINT ck_attendance_correction_reviewer CHECK (reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM requested_by)
);
CREATE INDEX ix_attendance_corrections_status ON attendance_corrections (tenant_id, status, created_at DESC);

-- -----------------------------------------------------------------------------
-- Leave
-- -----------------------------------------------------------------------------
CREATE TABLE leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  is_paid boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  allow_half_day boolean NOT NULL DEFAULT true,
  max_negative_days numeric(6, 2) NOT NULL DEFAULT 0 CHECK (max_negative_days >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_leave_types_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_leave_types_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE leave_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  accrual_frequency text NOT NULL DEFAULT 'yearly'
    CHECK (accrual_frequency IN ('none', 'monthly', 'quarterly', 'yearly', 'on_joining')),
  accrual_days numeric(6, 3) NOT NULL DEFAULT 0 CHECK (accrual_days >= 0),
  eligible_after_days integer NOT NULL DEFAULT 0 CHECK (eligible_after_days >= 0),
  probation_eligible boolean NOT NULL DEFAULT true,
  carry_forward_max_days numeric(6, 2) NOT NULL DEFAULT 0 CHECK (carry_forward_max_days >= 0),
  expiry_days integer CHECK (expiry_days > 0),
  count_weekly_offs boolean NOT NULL DEFAULT false,
  count_holidays boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_leave_policies_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_leave_policies_version UNIQUE (tenant_id, leave_type_id, version),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  CONSTRAINT ck_leave_policy_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_leave_policy_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, leave_type_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  leave_policy_id uuid,
  start_date date NOT NULL,
  end_date date NOT NULL,
  partial_day text CHECK (partial_day IN ('first_half', 'second_half')),
  requested_days numeric(6, 2) NOT NULL CHECK (requested_days > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_comment text,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_leave_requests_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_policy_id) REFERENCES leave_policies (tenant_id, id),
  CONSTRAINT ck_leave_dates CHECK (end_date >= start_date),
  CONSTRAINT ck_leave_partial_single_day CHECK (partial_day IS NULL OR start_date = end_date),
  CONSTRAINT ck_leave_decision CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX ix_leave_requests_status_dates ON leave_requests (tenant_id, status, start_date, end_date);
CREATE INDEX ix_leave_requests_employee_dates ON leave_requests (tenant_id, employee_id, start_date DESC);
CREATE TRIGGER trg_leave_requests_touch BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();

-- Overlap guard (half-days on opposite halves of one day may coexist). Serialised per employee.
CREATE FUNCTION app.guard_leave_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'approved') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.employee_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM leave_requests o
     WHERE o.tenant_id = NEW.tenant_id AND o.employee_id = NEW.employee_id
       AND o.id <> NEW.id AND o.status IN ('pending', 'approved')
       AND daterange(o.start_date, o.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
       AND NOT (o.partial_day IS NOT NULL AND NEW.partial_day IS NOT NULL AND o.partial_day <> NEW.partial_day)
  ) THEN
    RAISE EXCEPTION 'leave request overlaps an existing pending or approved request' USING ERRCODE = 'HT003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_requests_overlap BEFORE INSERT OR UPDATE OF start_date, end_date, partial_day, status ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION app.guard_leave_overlap();

-- Valid transitions only; decisions are immutable once made except approved -> cancelled.
CREATE FUNCTION app.guard_leave_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'leave request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'HT003';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NEW.decided_by IS NOT DISTINCT FROM (
       SELECT e.user_id FROM employees e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.employee_id) THEN
    RAISE EXCEPTION 'an employee cannot decide their own leave request' USING ERRCODE = 'HT004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_requests_transition BEFORE UPDATE OF status ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION app.guard_leave_transition();

-- Ledger: balances are the SUM of immutable transactions. Never mutate, only reverse.
CREATE TABLE leave_balance_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  source_request_id uuid,
  transaction_type text NOT NULL
    CHECK (transaction_type IN ('opening_grant', 'accrual', 'usage', 'reversal', 'manual_adjustment', 'carry_forward', 'expiry')),
  days_delta numeric(8, 3) NOT NULL CHECK (days_delta <> 0),
  effective_date date NOT NULL,
  reason text,
  idempotency_key text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_leave_balance_tx_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_leave_balance_tx_idempotency UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  FOREIGN KEY (tenant_id, source_request_id) REFERENCES leave_requests (tenant_id, id),
  CONSTRAINT ck_leave_tx_sign CHECK (
    (transaction_type IN ('opening_grant', 'accrual', 'reversal', 'carry_forward') AND days_delta > 0)
    OR (transaction_type IN ('usage', 'expiry') AND days_delta < 0)
    OR transaction_type = 'manual_adjustment'),
  CONSTRAINT ck_leave_tx_adjustment_reason CHECK (transaction_type <> 'manual_adjustment' OR reason IS NOT NULL)
);
CREATE INDEX ix_leave_balance_ledger ON leave_balance_transactions (tenant_id, employee_id, leave_type_id, effective_date);

-- Concurrency-safe overdraw protection: two parallel approvals of the last day cannot both win.
CREATE FUNCTION app.guard_leave_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_balance numeric; v_max_negative numeric;
BEGIN
  IF NEW.days_delta >= 0 THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.employee_id::text || NEW.leave_type_id::text, 1));
  SELECT COALESCE(SUM(days_delta), 0) INTO v_balance
    FROM leave_balance_transactions
   WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.employee_id AND leave_type_id = NEW.leave_type_id;
  SELECT max_negative_days INTO v_max_negative FROM leave_types
   WHERE tenant_id = NEW.tenant_id AND id = NEW.leave_type_id;
  IF v_balance + NEW.days_delta < -COALESCE(v_max_negative, 0) THEN
    RAISE EXCEPTION 'insufficient leave balance: have %, need %', v_balance, -NEW.days_delta USING ERRCODE = 'HT005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_balance_guard BEFORE INSERT ON leave_balance_transactions
  FOR EACH ROW EXECUTE FUNCTION app.guard_leave_balance();

CREATE VIEW leave_balances WITH (security_invoker = true) AS
  SELECT tenant_id, employee_id, leave_type_id, SUM(days_delta)::numeric(10, 3) AS balance_days,
         MAX(effective_date) AS last_transaction_date
    FROM leave_balance_transactions
   GROUP BY tenant_id, employee_id, leave_type_id;
GRANT SELECT ON leave_balances TO humantech_app;

-- -----------------------------------------------------------------------------
SELECT app.apply_tenant_rls('holidays');
SELECT app.apply_tenant_rls('shifts');
SELECT app.apply_tenant_rls('shift_assignments');
SELECT app.apply_tenant_rls('attendance_policies');
SELECT app.apply_tenant_rls('attendance_days');
SELECT app.apply_tenant_rls('attendance_events', 'append_only');
SELECT app.apply_tenant_rls('attendance_corrections');
SELECT app.apply_tenant_rls('leave_types');
SELECT app.apply_tenant_rls('leave_policies');
SELECT app.apply_tenant_rls('leave_requests');
SELECT app.apply_tenant_rls('leave_balance_transactions', 'append_only');
