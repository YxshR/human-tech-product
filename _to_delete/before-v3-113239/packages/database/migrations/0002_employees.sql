-- 0002_employees.sql
-- Employee master, effective-dated employment history, sensitive data (kept in separate
-- tables so field-level permissions are enforceable), onboarding and exit.
--
-- Design rules applied here (see docs/adr):
--  * A candidate, an employee and a login are three different things.
--  * employment_status (what they are) is separate from onboarding_status and
--    payroll_eligible (whether payroll may include them).
--  * Employee numbers are issued once per tenant and never reused.
--  * Sensitive identifiers/bank numbers are stored as ciphertext (envelope encryption is
--    performed by the application with a managed key); only last4 + a blind index are queryable.
--  * Aadhaar numbers are deliberately NOT a supported identifier type (see ADR-0010).

-- Generic per-tenant gap-tolerant counters (employee numbers, candidate codes, ...).
CREATE TABLE number_sequences (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sequence_key text NOT NULL CHECK (sequence_key ~ '^[a-z_]+$'),
  prefix text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Z0-9-]{0,10}$'),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  padding smallint NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 12),
  PRIMARY KEY (tenant_id, sequence_key)
);

-- Concurrency-safe issuing: the UPDATE row-locks the counter until commit, so two parallel
-- transactions can never receive the same number. Rolled-back transactions may leave gaps.
CREATE FUNCTION app.next_number(p_key text, p_default_prefix text DEFAULT '', p_padding smallint DEFAULT 4)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_prefix text; v_value bigint; v_pad smallint;
BEGIN
  INSERT INTO number_sequences (tenant_id, sequence_key, prefix, padding)
    VALUES (app.current_tenant_id(), p_key, p_default_prefix, p_padding)
    ON CONFLICT (tenant_id, sequence_key) DO NOTHING;
  UPDATE number_sequences
     SET next_value = next_value + 1
   WHERE tenant_id = app.current_tenant_id() AND sequence_key = p_key
  RETURNING prefix, next_value - 1, padding INTO v_prefix, v_value, v_pad;
  RETURN v_prefix || lpad(v_value::text, v_pad, '0');
END $$;

CREATE FUNCTION app.next_employee_number() RETURNS text LANGUAGE sql AS
  $$ SELECT app.next_number('employee', 'EMP', 4::smallint) $$;

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_number text NOT NULL,
  user_id uuid,                              -- login identity (optional)
  first_name text NOT NULL,
  middle_name text,
  last_name text,
  preferred_name text,
  work_email text,
  personal_email text,
  phone text,
  employment_status text NOT NULL DEFAULT 'onboarding'
    CHECK (employment_status IN ('onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived')),
  onboarding_status text NOT NULL DEFAULT 'not_started'
    CHECK (onboarding_status IN ('not_started', 'in_progress', 'complete')),
  payroll_eligible boolean NOT NULL DEFAULT false,
  employment_type text NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern', 'consultant')),
  joined_at date,
  probation_end_date date,
  exited_at date,
  last_working_date date,
  branch_id uuid,
  department_id uuid,
  designation_id uuid,
  cost_centre_id uuid,
  manager_id uuid,
  pay_group_id uuid,                         -- FK added in 0005 (pay_groups)
  timezone text,
  custom_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,        -- optimistic concurrency
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT uq_employees_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_employees_tenant_number UNIQUE (tenant_id, employee_number),
  CONSTRAINT uq_employees_tenant_user UNIQUE (tenant_id, user_id),
  CONSTRAINT fk_employee_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  CONSTRAINT fk_employee_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT fk_employee_department FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  CONSTRAINT fk_employee_designation FOREIGN KEY (tenant_id, designation_id) REFERENCES designations (tenant_id, id),
  CONSTRAINT fk_employee_cost_centre FOREIGN KEY (tenant_id, cost_centre_id) REFERENCES cost_centres (tenant_id, id),
  CONSTRAINT fk_employee_manager FOREIGN KEY (tenant_id, manager_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_employee_not_own_manager CHECK (manager_id IS NULL OR manager_id <> id),
  CONSTRAINT ck_employee_dates CHECK (exited_at IS NULL OR joined_at IS NULL OR exited_at >= joined_at),
  CONSTRAINT ck_employee_exited_has_date CHECK (employment_status <> 'exited' OR exited_at IS NOT NULL),
  CONSTRAINT ck_employee_payroll_needs_join CHECK (NOT payroll_eligible OR joined_at IS NOT NULL)
);
CREATE INDEX ix_employees_tenant_status_branch ON employees (tenant_id, employment_status, branch_id);
CREATE INDEX ix_employees_tenant_name ON employees (tenant_id, lower(first_name), lower(coalesce(last_name, '')));
CREATE INDEX ix_employees_tenant_manager ON employees (tenant_id, manager_id);
CREATE INDEX ix_employees_tenant_updated ON employees (tenant_id, updated_at DESC, id);
CREATE TRIGGER trg_employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();

-- Reporting lines may never form a cycle.
CREATE FUNCTION app.prevent_manager_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manager_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (
    WITH RECURSIVE chain(id, manager_id, depth) AS (
      SELECT e.id, e.manager_id, 1 FROM employees e
       WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.manager_id
      UNION ALL
      SELECT e.id, e.manager_id, c.depth + 1 FROM employees e
        JOIN chain c ON e.id = c.manager_id AND e.tenant_id = NEW.tenant_id
       WHERE c.depth < 50
    )
    SELECT 1 FROM chain WHERE id = NEW.id OR manager_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'reporting line would create a cycle' USING ERRCODE = 'HT003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_employees_no_cycle BEFORE INSERT OR UPDATE OF manager_id ON employees
  FOR EACH ROW EXECUTE FUNCTION app.prevent_manager_cycle();

-- Direct + indirect reports (used by manager-scope authorisation in the API).
CREATE FUNCTION app.reports_of(p_manager uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  WITH RECURSIVE r(id, depth) AS (
    SELECT e.id, 1 FROM employees e
     WHERE e.tenant_id = app.current_tenant_id() AND e.manager_id = p_manager
    UNION ALL
    SELECT e.id, r.depth + 1 FROM employees e JOIN r ON e.manager_id = r.id
     WHERE e.tenant_id = app.current_tenant_id() AND r.depth < 50
  )
  SELECT id FROM r
$$;

-- -----------------------------------------------------------------------------
-- Effective-dated employment history. Written automatically by a trigger so history
-- cannot be forgotten by application code.
-- -----------------------------------------------------------------------------
CREATE TABLE employment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  employment_status text NOT NULL,
  employment_type text,
  branch_id uuid,
  department_id uuid,
  designation_id uuid,
  manager_id uuid,
  change_reason text NOT NULL,
  changed_by uuid REFERENCES users(id),
  superseded_at timestamptz,                 -- corrections supersede, never delete
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employment_history_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_employment_history_employee FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT fk_employment_history_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT fk_employment_history_department FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  CONSTRAINT fk_employment_history_designation FOREIGN KEY (tenant_id, designation_id) REFERENCES designations (tenant_id, id),
  CONSTRAINT fk_employment_history_manager FOREIGN KEY (tenant_id, manager_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_employment_history_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- No two live rows for one employee may cover the same day.
  CONSTRAINT ex_employment_history_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (superseded_at IS NULL)
);
CREATE INDEX ix_employment_history_employee_dates ON employment_history (tenant_id, employee_id, effective_from DESC);

CREATE FUNCTION app.record_employment_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_eff date := COALESCE(NULLIF(current_setting('app.effective_date', true), '')::date, current_date);
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.employment_status, NEW.employment_type, NEW.branch_id, NEW.department_id, NEW.designation_id, NEW.manager_id)
         IS NOT DISTINCT FROM
         (OLD.employment_status, OLD.employment_type, OLD.branch_id, OLD.department_id, OLD.designation_id, OLD.manager_id)
  THEN
    RETURN NEW;
  END IF;

  -- A same-day (or future) live row is superseded by the new fact; an earlier open row is closed.
  UPDATE employment_history SET superseded_at = now()
   WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.id AND superseded_at IS NULL AND effective_from >= v_eff;
  UPDATE employment_history SET effective_to = v_eff - 1
   WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.id AND superseded_at IS NULL
     AND effective_to IS NULL AND effective_from < v_eff;

  INSERT INTO employment_history (tenant_id, employee_id, effective_from, employment_status, employment_type,
                                  branch_id, department_id, designation_id, manager_id, change_reason, changed_by)
  VALUES (NEW.tenant_id, NEW.id, v_eff, NEW.employment_status, NEW.employment_type,
          NEW.branch_id, NEW.department_id, NEW.designation_id, NEW.manager_id,
          COALESCE(app.current_reason(), CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'record updated' END),
          app.current_user_id());
  RETURN NEW;
END $$;
CREATE TRIGGER trg_employees_history AFTER INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app.record_employment_history();

-- -----------------------------------------------------------------------------
-- Personal / sensitive data (separate tables => separate permissions)
-- -----------------------------------------------------------------------------
CREATE TABLE employee_personal_details (
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  date_of_birth date,
  gender text CHECK (gender IN ('female', 'male', 'non_binary', 'undisclosed')),
  marital_status text CHECK (marital_status IN ('single', 'married', 'divorced', 'widowed', 'undisclosed')),
  nationality text,
  current_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  permanent_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE TRIGGER trg_employee_personal_touch BEFORE UPDATE ON employee_personal_details FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE employee_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_emergency_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

CREATE TABLE employee_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  identifier_type text NOT NULL CHECK (identifier_type IN ('pan', 'uan', 'esic_ip', 'passport', 'driving_licence')),
  value_ciphertext bytea NOT NULL,
  value_last4 text,
  blind_index bytea,                          -- HMAC(value) for duplicate detection without decryption
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_identifiers_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX uq_employee_identifier_live ON employee_identifiers (tenant_id, employee_id, identifier_type)
  WHERE superseded_at IS NULL;
CREATE INDEX ix_employee_identifier_blind ON employee_identifiers (tenant_id, identifier_type, blind_index);

CREATE TABLE employee_bank_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  account_holder_name text NOT NULL,
  account_number_ciphertext bytea NOT NULL,
  account_number_last4 char(4),
  bank_name text,
  ifsc_ciphertext bytea,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'verified', 'rejected', 'superseded')),
  effective_from date NOT NULL,
  effective_to date,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_bank_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_employee_bank_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Whoever enters bank details cannot be the one who verifies them.
  CONSTRAINT ck_employee_bank_maker_checker CHECK (verified_by IS NULL OR verified_by IS DISTINCT FROM created_by),
  CONSTRAINT ex_employee_bank_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status IN ('pending_verification', 'verified'))
);

-- -----------------------------------------------------------------------------
-- Onboarding / offboarding
-- -----------------------------------------------------------------------------
CREATE TABLE onboarding_task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  phase text NOT NULL DEFAULT 'onboarding' CHECK (phase IN ('onboarding', 'offboarding')),
  title text NOT NULL,
  description text,
  owner_role_key text,
  due_offset_days integer NOT NULL DEFAULT 0,
  required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  CONSTRAINT uq_onboarding_tpl_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_onboarding_tpl_code UNIQUE (tenant_id, code)
);

CREATE TABLE onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  template_id uuid,
  phase text NOT NULL DEFAULT 'onboarding' CHECK (phase IN ('onboarding', 'offboarding')),
  title text NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  due_date date,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'waived')),
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  waiver_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_onboarding_tasks_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES onboarding_task_templates (tenant_id, id),
  CONSTRAINT ck_onboarding_waiver CHECK (status <> 'waived' OR waiver_reason IS NOT NULL)
);
CREATE INDEX ix_onboarding_tasks_employee ON onboarding_tasks (tenant_id, employee_id, status);

CREATE TABLE employee_exits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'notice_period', 'clearance', 'settlement_pending', 'completed', 'cancelled')),
  resignation_date date,
  last_working_date date NOT NULL,
  reason_code text,
  reason_notes text,
  access_revoked_at timestamptz,
  final_settlement_status text NOT NULL DEFAULT 'not_started'
    CHECK (final_settlement_status IN ('not_started', 'in_progress', 'paid', 'not_applicable')),
  initiated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_exits_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE UNIQUE INDEX uq_employee_exit_open ON employee_exits (tenant_id, employee_id) WHERE status <> 'cancelled';
CREATE TRIGGER trg_employee_exits_touch BEFORE UPDATE ON employee_exits FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
SELECT app.apply_tenant_rls('number_sequences');
SELECT app.apply_tenant_rls('employees');
SELECT app.apply_tenant_rls('employment_history');
SELECT app.apply_tenant_rls('employee_personal_details');
SELECT app.apply_tenant_rls('employee_emergency_contacts');
SELECT app.apply_tenant_rls('employee_identifiers');
SELECT app.apply_tenant_rls('employee_bank_details');
SELECT app.apply_tenant_rls('onboarding_task_templates');
SELECT app.apply_tenant_rls('onboarding_tasks');
SELECT app.apply_tenant_rls('employee_exits');
