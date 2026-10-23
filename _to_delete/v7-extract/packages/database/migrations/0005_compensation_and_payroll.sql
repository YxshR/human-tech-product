-- 0005_compensation_and_payroll.sql
-- Effective-dated compensation, versioned statutory rule sets, and the controlled payroll
-- state machine. The database - not just the API - refuses the dangerous things:
--   * editing a locked/finalised run, its items or its lines          (HT002)
--   * skipping or reversing states                                    (HT003)
--   * preparer approving their own run when maker-checker is on       (HT004)
--   * touching attendance inside a locked payroll period              (HT006)
--   * approving with unresolved blocking exceptions / unreconciled totals
--
-- Money: final amounts are numeric(14,2); rates numeric(12,6). Intermediate precision
-- (19,4) lives in the calculation trace. Binary floating point is never used.

-- -----------------------------------------------------------------------------
-- Pay groups (who is paid together, on what calendar)
-- -----------------------------------------------------------------------------
CREATE TABLE pay_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'semi_monthly', 'weekly')),
  period_start_day smallint NOT NULL DEFAULT 1 CHECK (period_start_day BETWEEN 1 AND 28),
  input_cutoff_day smallint CHECK (input_cutoff_day BETWEEN 1 AND 31),
  pay_day smallint CHECK (pay_day BETWEEN 1 AND 31),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pay_groups_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_pay_groups_tenant_code UNIQUE (tenant_id, code)
);

ALTER TABLE employees
  ADD CONSTRAINT fk_employee_pay_group FOREIGN KEY (tenant_id, pay_group_id) REFERENCES pay_groups (tenant_id, id),
  ADD CONSTRAINT ck_employee_payroll_needs_pay_group CHECK (NOT payroll_eligible OR pay_group_id IS NOT NULL);

-- -----------------------------------------------------------------------------
-- Statutory rule sets: GLOBAL, platform-managed, versioned, effective-dated, reviewed.
-- The software mechanism ships first; actual rule content is loaded only after review.
-- -----------------------------------------------------------------------------
CREATE TABLE statutory_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction char(2) NOT NULL DEFAULT 'IN',
  rule_group text NOT NULL CHECK (rule_group IN
    ('pf', 'esi', 'professional_tax', 'tds', 'lwf', 'gratuity', 'bonus', 'minimum_wage', 'other')),
  state_code text,                           -- NULL = central / all states
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  definition jsonb NOT NULL,                 -- validated against the engine's rule schema
  source_url text NOT NULL,
  source_reference text,
  source_published_on date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'retired')),
  prepared_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_rule_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A rule becomes active only after a DIFFERENT person reviewed it.
  CONSTRAINT ck_rule_review CHECK (status NOT IN ('approved', 'retired')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS DISTINCT FROM prepared_by)),
  CONSTRAINT ex_rule_no_overlap EXCLUDE USING gist (
    jurisdiction WITH =, rule_group WITH =, (COALESCE(state_code, '--')) WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'approved')
);
CREATE UNIQUE INDEX uq_rule_version ON statutory_rule_sets (jurisdiction, rule_group, COALESCE(state_code, '--'), version);

CREATE FUNCTION app.freeze_approved_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'reviewed statutory rule sets cannot be deleted' USING ERRCODE = 'HT002';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('approved', 'retired')
     AND (NEW.definition, NEW.effective_from, NEW.rule_group, NEW.state_code, NEW.version)
         IS DISTINCT FROM (OLD.definition, OLD.effective_from, OLD.rule_group, OLD.state_code, OLD.version) THEN
    RAISE EXCEPTION 'an approved statutory rule set is immutable; publish a new version' USING ERRCODE = 'HT002';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_rule_freeze BEFORE UPDATE OR DELETE ON statutory_rule_sets
  FOR EACH ROW EXECUTE FUNCTION app.freeze_approved_rule();

ALTER TABLE statutory_rule_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_read_reviewed ON statutory_rule_sets AS PERMISSIVE FOR SELECT TO humantech_app
  USING (status IN ('approved', 'retired'));
CREATE POLICY system_all ON statutory_rule_sets AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
GRANT SELECT ON statutory_rule_sets TO humantech_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_rule_sets TO humantech_system;

-- -----------------------------------------------------------------------------
-- Salary components: identity + immutable, effective-dated versions
-- -----------------------------------------------------------------------------
CREATE TABLE salary_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  label text NOT NULL,
  component_type text NOT NULL CHECK (component_type IN ('earning', 'employee_deduction', 'employer_contribution', 'informational')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_salary_components_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_salary_components_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE salary_component_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  component_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  label_snapshot text NOT NULL,
  calculation_method text NOT NULL
    CHECK (calculation_method IN ('fixed', 'percentage_of_component', 'per_day', 'per_unit', 'manual', 'statutory')),
  base_component_codes text[] NOT NULL DEFAULT '{}',   -- bases for percentage_of_component
  default_amount numeric(14, 2) CHECK (default_amount >= 0),
  default_percentage numeric(12, 6) CHECK (default_percentage >= 0),
  rounding_mode text NOT NULL DEFAULT 'half_up' CHECK (rounding_mode IN ('half_up', 'half_even', 'down', 'up')),
  rounding_places smallint NOT NULL DEFAULT 2 CHECK (rounding_places BETWEEN 0 AND 4),
  is_taxable boolean NOT NULL DEFAULT true,
  prorate_on_unpaid_days boolean NOT NULL DEFAULT true,
  statutory_group text CHECK (statutory_group IN
    ('pf', 'esi', 'professional_tax', 'tds', 'lwf', 'gratuity', 'bonus', 'other')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_component_versions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_component_versions_version UNIQUE (tenant_id, component_id, version),
  FOREIGN KEY (tenant_id, component_id) REFERENCES salary_components (tenant_id, id),
  CONSTRAINT ck_component_version_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_component_version_method CHECK (
    (calculation_method <> 'percentage_of_component') OR (default_percentage IS NOT NULL AND cardinality(base_component_codes) > 0)),
  CONSTRAINT ex_component_version_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, component_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);

-- Once a version leaves 'draft' its calculation definition can never change.
CREATE FUNCTION app.freeze_component_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a published component version cannot be deleted' USING ERRCODE = 'HT002';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.calculation_method, NEW.base_component_codes, NEW.default_amount, NEW.default_percentage,
       NEW.rounding_mode, NEW.rounding_places, NEW.is_taxable, NEW.prorate_on_unpaid_days,
       NEW.statutory_group, NEW.configuration, NEW.effective_from, NEW.version)
     IS DISTINCT FROM (
       OLD.calculation_method, OLD.base_component_codes, OLD.default_amount, OLD.default_percentage,
       OLD.rounding_mode, OLD.rounding_places, OLD.is_taxable, OLD.prorate_on_unpaid_days,
       OLD.statutory_group, OLD.configuration, OLD.effective_from, OLD.version) THEN
    RAISE EXCEPTION 'a published component version is immutable; create a new version' USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_component_version_freeze BEFORE UPDATE OR DELETE ON salary_component_versions
  FOR EACH ROW EXECUTE FUNCTION app.freeze_component_version();

CREATE TABLE salary_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_salary_structures_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_salary_structures_version UNIQUE (tenant_id, code, version),
  CONSTRAINT ck_salary_structure_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE salary_structure_components (
  tenant_id uuid NOT NULL,
  salary_structure_id uuid NOT NULL,
  component_version_id uuid NOT NULL,
  amount numeric(14, 2) CHECK (amount >= 0),
  percentage numeric(12, 6) CHECK (percentage >= 0),
  display_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, salary_structure_id, component_version_id),
  FOREIGN KEY (tenant_id, salary_structure_id) REFERENCES salary_structures (tenant_id, id),
  FOREIGN KEY (tenant_id, component_version_id) REFERENCES salary_component_versions (tenant_id, id)
);

CREATE FUNCTION app.freeze_structure_components() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_tenant uuid; v_structure uuid;
BEGIN
  v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_structure := COALESCE(NEW.salary_structure_id, OLD.salary_structure_id);
  SELECT status INTO v_status FROM salary_structures WHERE tenant_id = v_tenant AND id = v_structure;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'components of a published salary structure cannot change; create a new version'
      USING ERRCODE = 'HT002';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_structure_components_freeze BEFORE INSERT OR UPDATE OR DELETE ON salary_structure_components
  FOR EACH ROW EXECUTE FUNCTION app.freeze_structure_components();

-- -----------------------------------------------------------------------------
-- Employee salary assignments (effective-dated, non-overlapping, approved)
-- -----------------------------------------------------------------------------
CREATE TABLE employee_salary_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  salary_structure_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  effective_from date NOT NULL,
  effective_to date,
  monthly_ctc numeric(14, 2) CHECK (monthly_ctc >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  change_reason text NOT NULL,
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_by uuid REFERENCES users(id),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_salary_assignment_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, salary_structure_id) REFERENCES salary_structures (tenant_id, id),
  CONSTRAINT ck_salary_assignment_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_salary_assignment_approval CHECK (approval_status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  -- Whoever proposes a salary cannot approve it.
  CONSTRAINT ck_salary_assignment_maker_checker CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by),
  CONSTRAINT ex_salary_assignment_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (superseded_at IS NULL AND approval_status <> 'rejected')
);
CREATE INDEX ix_salary_assignment_employee_dates ON employee_salary_assignments (tenant_id, employee_id, effective_from DESC);

CREATE TABLE employee_salary_overrides (
  tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  component_version_id uuid NOT NULL,
  amount numeric(14, 2) CHECK (amount >= 0),
  percentage numeric(12, 6) CHECK (percentage >= 0),
  PRIMARY KEY (tenant_id, assignment_id, component_version_id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES employee_salary_assignments (tenant_id, id),
  FOREIGN KEY (tenant_id, component_version_id) REFERENCES salary_component_versions (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Payroll periods and runs
-- -----------------------------------------------------------------------------
CREATE TABLE payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pay_group_id uuid NOT NULL,
  period_code text NOT NULL,                 -- e.g. 2026-10
  period_start date NOT NULL,
  period_end date NOT NULL,
  input_cutoff_at timestamptz,
  attendance_locked_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed', 'archived')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_period_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_payroll_period_code UNIQUE (tenant_id, pay_group_id, period_code),
  FOREIGN KEY (tenant_id, pay_group_id) REFERENCES pay_groups (tenant_id, id),
  CONSTRAINT ck_payroll_period_dates CHECK (period_end >= period_start),
  CONSTRAINT ex_payroll_period_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, pay_group_id WITH =, daterange(period_start, period_end, '[]') WITH &&
  )
);

CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payroll_period_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  run_kind text NOT NULL DEFAULT 'regular' CHECK (run_kind IN ('regular', 'off_cycle', 'correction')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'validated', 'calculated', 'under_review', 'rejected', 'approved', 'locked', 'payslips_generated', 'cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid')),
  engine_version text,
  input_hash text,
  rule_bundle_hash text,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_gross numeric(16, 2),
  total_employee_deductions numeric(16, 2),
  total_employer_contributions numeric(16, 2),
  total_net_pay numeric(16, 2),
  correction_of_run_id uuid,
  correction_reason text,
  rejection_reason text,
  created_by uuid REFERENCES users(id),
  validated_at timestamptz,
  calculated_at timestamptz,
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  rejected_by uuid REFERENCES users(id),
  rejected_at timestamptz,
  locked_by uuid REFERENCES users(id),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_run_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_payroll_run_revision UNIQUE (tenant_id, payroll_period_id, revision),
  FOREIGN KEY (tenant_id, payroll_period_id) REFERENCES payroll_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, correction_of_run_id) REFERENCES payroll_runs (tenant_id, id),
  CONSTRAINT ck_payroll_run_correction CHECK (
    (correction_of_run_id IS NULL AND correction_reason IS NULL AND run_kind <> 'correction')
    OR (correction_of_run_id IS NOT NULL AND correction_reason IS NOT NULL AND run_kind = 'correction')),
  CONSTRAINT ck_payroll_run_rejection CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
-- Only ONE in-flight run per period at a time; finalised runs stay for history.
CREATE UNIQUE INDEX uq_payroll_run_in_flight ON payroll_runs (tenant_id, payroll_period_id)
  WHERE status NOT IN ('locked', 'payslips_generated', 'cancelled');
CREATE INDEX ix_payroll_runs_tenant_period_status ON payroll_runs (tenant_id, payroll_period_id, status);
CREATE TRIGGER trg_payroll_runs_touch BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE payroll_run_rule_sets (
  tenant_id uuid NOT NULL,
  payroll_run_id uuid NOT NULL,
  rule_set_id uuid NOT NULL REFERENCES statutory_rule_sets(id),
  PRIMARY KEY (tenant_id, payroll_run_id, rule_set_id),
  FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs (tenant_id, id)
);

CREATE TABLE payroll_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payroll_run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  salary_assignment_id uuid,
  input_snapshot jsonb NOT NULL,
  working_days numeric(6, 2) CHECK (working_days >= 0),
  paid_days numeric(6, 2) CHECK (paid_days >= 0),
  unpaid_days numeric(6, 2) CHECK (unpaid_days >= 0),
  gross_earnings numeric(14, 2) NOT NULL DEFAULT 0 CHECK (gross_earnings >= 0),
  employee_deductions numeric(14, 2) NOT NULL DEFAULT 0 CHECK (employee_deductions >= 0),
  employer_contributions numeric(14, 2) NOT NULL DEFAULT 0 CHECK (employer_contributions >= 0),
  net_pay numeric(14, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'needs_review', 'excluded')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_run_item_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_payroll_run_item_employee UNIQUE (tenant_id, payroll_run_id, employee_id),
  FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, salary_assignment_id) REFERENCES employee_salary_assignments (tenant_id, id),
  -- The accounting identity is enforced by the database, not just the engine.
  CONSTRAINT ck_payroll_item_net CHECK (net_pay = gross_earnings - employee_deductions)
);
CREATE INDEX ix_payroll_run_items_employee ON payroll_run_items (tenant_id, employee_id, created_at DESC);

CREATE TABLE payroll_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payroll_run_item_id uuid NOT NULL,
  component_code text NOT NULL,
  component_version_id uuid,
  component_label_snapshot text NOT NULL,
  component_type text NOT NULL CHECK (component_type IN ('earning', 'employee_deduction', 'employer_contribution', 'informational')),
  calculation_method text NOT NULL,
  quantity numeric(10, 4),
  calculation_base numeric(14, 2),
  applied_rate numeric(12, 6),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  rule_set_id uuid REFERENCES statutory_rule_sets(id),
  display_order integer NOT NULL DEFAULT 0,
  trace jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_line_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_run_item_id) REFERENCES payroll_run_items (tenant_id, id),
  FOREIGN KEY (tenant_id, component_version_id) REFERENCES salary_component_versions (tenant_id, id)
);
CREATE INDEX ix_payroll_lines_run_item ON payroll_line_items (tenant_id, payroll_run_item_id, display_order);

CREATE TABLE payroll_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payroll_run_id uuid NOT NULL,
  payroll_run_item_id uuid,
  employee_id uuid,
  stage text NOT NULL CHECK (stage IN ('validation', 'calculation', 'review')),
  severity text NOT NULL CHECK (severity IN ('blocking', 'warning')),
  code text NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_exceptions_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_run_item_id) REFERENCES payroll_run_items (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_payroll_exception_resolution CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX ix_payroll_exceptions_run_open ON payroll_exceptions (tenant_id, payroll_run_id, severity) WHERE status = 'open';

-- One-off additions/deductions, arrears and correction amounts feeding a payroll period.
CREATE TABLE payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  payroll_period_id uuid NOT NULL,
  component_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('earning', 'deduction')),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'arrears', 'correction')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'applied', 'cancelled')),
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  applied_run_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_adjustments_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_period_id) REFERENCES payroll_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, component_id) REFERENCES salary_components (tenant_id, id),
  FOREIGN KEY (tenant_id, applied_run_item_id) REFERENCES payroll_run_items (tenant_id, id),
  CONSTRAINT ck_payroll_adjustment_maker_checker CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by),
  CONSTRAINT ck_payroll_adjustment_approved CHECK (status NOT IN ('approved', 'applied') OR approved_by IS NOT NULL)
);

-- =============================================================================
-- Payroll state machine
-- =============================================================================
CREATE FUNCTION app.payroll_run_transition_allowed(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'validated'), ('draft', 'cancelled'),
    ('validated', 'calculated'), ('validated', 'draft'), ('validated', 'cancelled'),
    ('calculated', 'under_review'), ('calculated', 'draft'), ('calculated', 'cancelled'),
    ('under_review', 'approved'), ('under_review', 'rejected'),
    ('rejected', 'draft'), ('rejected', 'cancelled'),
    ('approved', 'locked'), ('approved', 'rejected'),
    ('locked', 'payslips_generated'))
$$;

-- Item and line totals must reconcile before a run can be locked.
CREATE FUNCTION app.verify_payroll_run_totals(p_tenant uuid, p_run uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payroll_run_items i
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(amount) FILTER (WHERE component_type = 'earning'), 0) AS e,
             COALESCE(SUM(amount) FILTER (WHERE component_type = 'employee_deduction'), 0) AS d,
             COALESCE(SUM(amount) FILTER (WHERE component_type = 'employer_contribution'), 0) AS c
        FROM payroll_line_items l WHERE l.tenant_id = i.tenant_id AND l.payroll_run_item_id = i.id
    ) s ON true
    WHERE i.tenant_id = p_tenant AND i.payroll_run_id = p_run AND i.status <> 'excluded'
      AND (i.gross_earnings <> s.e OR i.employee_deductions <> s.d OR i.employer_contributions <> s.c)
  ) THEN
    RAISE EXCEPTION 'payroll line items do not reconcile with employee totals' USING ERRCODE = 'HT003';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payroll_runs r
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(gross_earnings), 0) AS g, COALESCE(SUM(employee_deductions), 0) AS d,
             COALESCE(SUM(employer_contributions), 0) AS c, COALESCE(SUM(net_pay), 0) AS n
        FROM payroll_run_items i WHERE i.tenant_id = r.tenant_id AND i.payroll_run_id = r.id AND i.status <> 'excluded'
    ) s ON true
    WHERE r.tenant_id = p_tenant AND r.id = p_run
      AND (r.total_gross IS DISTINCT FROM s.g OR r.total_employee_deductions IS DISTINCT FROM s.d
        OR r.total_employer_contributions IS DISTINCT FROM s.c OR r.total_net_pay IS DISTINCT FROM s.n)
  ) THEN
    RAISE EXCEPTION 'payroll run totals do not reconcile with its employee items' USING ERRCODE = 'HT003';
  END IF;
END $$;

CREATE FUNCTION app.guard_payroll_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_required boolean;
  v_activated timestamptz;
  v_prev record;
  v_open integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft payroll runs can be deleted' USING ERRCODE = 'HT002';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT payroll_activated_at INTO v_activated FROM tenants WHERE id = NEW.tenant_id;
    IF v_activated IS NULL THEN
      RAISE EXCEPTION 'payroll has not been activated for this tenant' USING ERRCODE = 'HT003';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a payroll run must be created in draft' USING ERRCODE = 'HT003';
    END IF;
    IF NEW.revision = 1 THEN
      IF NEW.correction_of_run_id IS NOT NULL THEN
        RAISE EXCEPTION 'revision 1 cannot be a correction' USING ERRCODE = 'HT003';
      END IF;
    ELSE
      SELECT status, revision, payroll_period_id INTO v_prev FROM payroll_runs
       WHERE tenant_id = NEW.tenant_id AND id = NEW.correction_of_run_id;
      IF NOT FOUND OR v_prev.status NOT IN ('locked', 'payslips_generated')
         OR v_prev.payroll_period_id <> NEW.payroll_period_id OR v_prev.revision <> NEW.revision - 1 THEN
        RAISE EXCEPTION 'a correction revision must follow a finalised run of the same period' USING ERRCODE = 'HT003';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE ---------------------------------------------------------------
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled payroll run cannot change' USING ERRCODE = 'HT002';
  END IF;

  IF OLD.status IN ('locked', 'payslips_generated') THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'payment_status', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'payment_status', 'updated_at']) THEN
      RAISE EXCEPTION 'a finalised payroll run is immutable; create a controlled correction revision' USING ERRCODE = 'HT002';
    END IF;
  END IF;

  IF NOT app.payroll_run_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'payroll run cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'HT003';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  IF NEW.status = 'validated' THEN
    SELECT count(*) INTO v_open FROM payroll_exceptions
     WHERE tenant_id = NEW.tenant_id AND payroll_run_id = NEW.id
       AND stage = 'validation' AND severity = 'blocking' AND status = 'open';
    IF v_open > 0 THEN
      RAISE EXCEPTION '% blocking validation exception(s) are unresolved', v_open USING ERRCODE = 'HT003';
    END IF;
    NEW.validated_at := COALESCE(NEW.validated_at, now());
  ELSIF NEW.status = 'calculated' THEN
    IF NEW.engine_version IS NULL OR NEW.input_hash IS NULL OR NEW.rule_bundle_hash IS NULL THEN
      RAISE EXCEPTION 'a calculated run must record engine version, input hash and rule bundle hash' USING ERRCODE = 'HT003';
    END IF;
    NEW.calculated_at := COALESCE(NEW.calculated_at, now());
  ELSIF NEW.status = 'under_review' THEN
    IF NEW.submitted_by IS NULL THEN
      RAISE EXCEPTION 'submitting for review requires submitted_by' USING ERRCODE = 'HT003';
    END IF;
    NEW.submitted_at := COALESCE(NEW.submitted_at, now());
  ELSIF NEW.status = 'rejected' THEN
    NEW.rejected_at := COALESCE(NEW.rejected_at, now());
  ELSIF NEW.status = 'approved' THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'approval requires approved_by' USING ERRCODE = 'HT004';
    END IF;
    SELECT payroll_maker_checker_required INTO v_required FROM tenants WHERE id = NEW.tenant_id;
    IF COALESCE(v_required, true)
       AND (NEW.approved_by IS NOT DISTINCT FROM NEW.created_by OR NEW.approved_by IS NOT DISTINCT FROM NEW.submitted_by) THEN
      RAISE EXCEPTION 'maker-checker: the preparer of a payroll run cannot approve it' USING ERRCODE = 'HT004';
    END IF;
    SELECT count(*) INTO v_open FROM payroll_exceptions
     WHERE tenant_id = NEW.tenant_id AND payroll_run_id = NEW.id AND severity = 'blocking' AND status = 'open';
    IF v_open > 0 THEN
      RAISE EXCEPTION '% blocking exception(s) are unresolved', v_open USING ERRCODE = 'HT003';
    END IF;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
  ELSIF NEW.status = 'locked' THEN
    IF NEW.locked_by IS NULL THEN
      RAISE EXCEPTION 'finalising requires locked_by' USING ERRCODE = 'HT004';
    END IF;
    PERFORM app.verify_payroll_run_totals(NEW.tenant_id, NEW.id);
    NEW.locked_at := COALESCE(NEW.locked_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_run();

-- Items, lines and rule bindings may only change while the run is still being prepared.
CREATE FUNCTION app.guard_payroll_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_run uuid; v_status text;
BEGIN
  v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  IF TG_TABLE_NAME = 'payroll_line_items' THEN
    SELECT payroll_run_id INTO v_run FROM payroll_run_items
     WHERE tenant_id = v_tenant AND id = COALESCE(NEW.payroll_run_item_id, OLD.payroll_run_item_id);
  ELSE
    v_run := COALESCE(NEW.payroll_run_id, OLD.payroll_run_id);
  END IF;
  SELECT status INTO v_status FROM payroll_runs WHERE tenant_id = v_tenant AND id = v_run;
  IF v_status IS NULL OR v_status NOT IN ('draft', 'validated', 'calculated') THEN
    RAISE EXCEPTION 'payroll data is frozen once a run is % ', COALESCE(v_status, 'missing') USING ERRCODE = 'HT002';
  END IF;
  IF TG_TABLE_NAME = 'payroll_run_rule_sets' AND TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM statutory_rule_sets WHERE id = NEW.rule_set_id AND status = 'approved') THEN
      RAISE EXCEPTION 'only approved statutory rule sets can be bound to a payroll run' USING ERRCODE = 'HT003';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_payroll_items_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_children();
CREATE TRIGGER trg_payroll_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_line_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_children();
CREATE TRIGGER trg_payroll_rule_sets_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_rule_sets
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_children();

-- Salary assignments that a finalised run used are part of payroll history.
CREATE FUNCTION app.guard_assignment_in_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_run_items i JOIN payroll_runs r ON r.tenant_id = i.tenant_id AND r.id = i.payroll_run_id
              WHERE i.tenant_id = OLD.tenant_id AND i.salary_assignment_id = OLD.id
                AND r.status IN ('locked', 'payslips_generated'))
     AND (NEW.salary_structure_id, NEW.monthly_ctc, NEW.effective_from) IS DISTINCT FROM
         (OLD.salary_structure_id, OLD.monthly_ctc, OLD.effective_from) THEN
    RAISE EXCEPTION 'a salary assignment used by finalised payroll cannot be edited; supersede it' USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_assignment_in_use BEFORE UPDATE ON employee_salary_assignments
  FOR EACH ROW EXECUTE FUNCTION app.guard_assignment_in_use();

-- Attendance inside a locked payroll period is frozen (cutoff rule).
CREATE FUNCTION app.guard_attendance_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_employee uuid; v_date date;
BEGIN
  v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_employee := COALESCE(NEW.employee_id, OLD.employee_id);
  v_date := COALESCE(NEW.work_date, OLD.work_date);
  IF EXISTS (
    SELECT 1 FROM payroll_periods p
      JOIN employees e ON e.tenant_id = p.tenant_id AND e.pay_group_id = p.pay_group_id
     WHERE p.tenant_id = v_tenant AND e.id = v_employee
       AND p.attendance_locked_at IS NOT NULL AND v_date BETWEEN p.period_start AND p.period_end
  ) THEN
    RAISE EXCEPTION 'attendance for % is locked for payroll; use a controlled payroll adjustment', v_date USING ERRCODE = 'HT006';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_attendance_days_lock BEFORE INSERT OR UPDATE OR DELETE ON attendance_days
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_lock();

-- -----------------------------------------------------------------------------
SELECT app.apply_tenant_rls('pay_groups');
SELECT app.apply_tenant_rls('salary_components');
SELECT app.apply_tenant_rls('salary_component_versions');
SELECT app.apply_tenant_rls('salary_structures');
SELECT app.apply_tenant_rls('salary_structure_components');
SELECT app.apply_tenant_rls('employee_salary_assignments');
SELECT app.apply_tenant_rls('employee_salary_overrides');
SELECT app.apply_tenant_rls('payroll_periods');
SELECT app.apply_tenant_rls('payroll_runs');
SELECT app.apply_tenant_rls('payroll_run_rule_sets');
SELECT app.apply_tenant_rls('payroll_run_items');
SELECT app.apply_tenant_rls('payroll_line_items');
SELECT app.apply_tenant_rls('payroll_exceptions');
SELECT app.apply_tenant_rls('payroll_adjustments');
