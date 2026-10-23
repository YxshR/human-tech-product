-- 0003_recruitment.sql
-- Lightweight recruitment table (not a full ATS): clients, job requirements, candidates,
-- an enforced stage state machine and DB-guaranteed stage history.
-- Candidate salary data lives in its own table so it can be permissioned separately.

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_clients_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_clients_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE job_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid,
  code text NOT NULL,
  title text NOT NULL,
  location text,
  openings integer NOT NULL DEFAULT 1 CHECK (openings > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'on_hold', 'filled', 'closed')),
  owner_user_id uuid REFERENCES users(id),
  opened_at date NOT NULL DEFAULT current_date,
  closed_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_job_requirements_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_job_requirements_tenant_code UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  CONSTRAINT ck_job_dates CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

-- -----------------------------------------------------------------------------
-- Stage machine
--   pipeline : lead_new > contacted > screening > submitted_to_client > interview
--              > selected_offer > joined
--   outcomes : rejected, withdrawn, on_hold
-- Rules: forward to any later stage; backward only one step (reason required);
--        joined only from selected_offer and is terminal; rejected/withdrawn can only be
--        reopened to lead_new (reason required); on_hold can resume to any open stage.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.candidate_stage_ordinal(p_stage text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_stage
    WHEN 'lead_new' THEN 1 WHEN 'contacted' THEN 2 WHEN 'screening' THEN 3
    WHEN 'submitted_to_client' THEN 4 WHEN 'interview' THEN 5
    WHEN 'selected_offer' THEN 6 WHEN 'joined' THEN 7
  END
$$;

CREATE FUNCTION app.candidate_stage_transition_allowed(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN false
    WHEN p_from = 'joined' THEN false
    WHEN p_from IN ('rejected', 'withdrawn') THEN p_to = 'lead_new'
    WHEN p_to IN ('rejected', 'withdrawn', 'on_hold') THEN true
    WHEN p_to = 'joined' THEN p_from = 'selected_offer'
    WHEN p_from = 'on_hold' THEN true
    ELSE app.candidate_stage_ordinal(p_to) > app.candidate_stage_ordinal(p_from)
      OR app.candidate_stage_ordinal(p_to) = app.candidate_stage_ordinal(p_from) - 1
  END
$$;

CREATE FUNCTION app.candidate_stage_needs_reason(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_to IN ('rejected', 'withdrawn', 'on_hold')
      OR p_from IN ('rejected', 'withdrawn')
      OR (app.candidate_stage_ordinal(p_to) IS NOT NULL
          AND app.candidate_stage_ordinal(p_from) IS NOT NULL
          AND app.candidate_stage_ordinal(p_to) < app.candidate_stage_ordinal(p_from))
$$;

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  candidate_code text NOT NULL,
  first_name text NOT NULL,
  last_name text,
  email_normalized text CHECK (email_normalized = lower(email_normalized)),
  phone_normalized text CHECK (phone_normalized ~ '^\+?[0-9]{6,15}$'),
  city text,
  source text,
  client_id uuid,
  job_requirement_id uuid,
  role_title text,
  recruiter_user_id uuid REFERENCES users(id),
  total_experience_months integer CHECK (total_experience_months >= 0),
  relevant_experience_months integer CHECK (relevant_experience_months >= 0),
  notice_period_days integer CHECK (notice_period_days >= 0),
  available_from date,
  current_stage text NOT NULL DEFAULT 'lead_new'
    CHECK (current_stage IN ('lead_new', 'contacted', 'screening', 'submitted_to_client', 'interview',
                             'selected_offer', 'joined', 'rejected', 'withdrawn', 'on_hold')),
  next_follow_up_at timestamptz,
  closure_reason text,
  tags text[] NOT NULL DEFAULT '{}',
  converted_employee_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT uq_candidates_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_candidates_tenant_code UNIQUE (tenant_id, candidate_code),
  CONSTRAINT fk_candidate_client FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  CONSTRAINT fk_candidate_job FOREIGN KEY (tenant_id, job_requirement_id) REFERENCES job_requirements (tenant_id, id),
  CONSTRAINT fk_candidate_converted_employee FOREIGN KEY (tenant_id, converted_employee_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_candidate_closure_reason CHECK (current_stage NOT IN ('rejected', 'withdrawn') OR closure_reason IS NOT NULL),
  CONSTRAINT ck_candidate_contactable CHECK (email_normalized IS NOT NULL OR phone_normalized IS NOT NULL)
);
-- A converted candidate maps to exactly one employee and vice versa.
CREATE UNIQUE INDEX uq_candidates_converted_employee ON candidates (tenant_id, converted_employee_id)
  WHERE converted_employee_id IS NOT NULL;
CREATE INDEX ix_candidates_tenant_stage_updated ON candidates (tenant_id, current_stage, updated_at DESC, id);
CREATE INDEX ix_candidates_tenant_email ON candidates (tenant_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX ix_candidates_tenant_phone ON candidates (tenant_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX ix_candidates_follow_up ON candidates (tenant_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL AND current_stage NOT IN ('joined', 'rejected', 'withdrawn');
CREATE INDEX ix_candidates_recruiter ON candidates (tenant_id, recruiter_user_id);
CREATE TRIGGER trg_candidates_touch BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();

-- Sensitive: salary data is permissioned separately (candidate.read_salary).
CREATE TABLE candidate_compensation (
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  current_ctc numeric(14, 2) CHECK (current_ctc >= 0),
  expected_ctc numeric(14, 2) CHECK (expected_ctc >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, candidate_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id)
);
CREATE TRIGGER trg_candidate_comp_touch BEFORE UPDATE ON candidate_compensation FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE candidate_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  from_stage text,
  to_stage text NOT NULL,
  reason text,
  actor_user_id uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_history_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id)
);
CREATE INDEX ix_candidate_history_candidate ON candidate_stage_history (tenant_id, candidate_id, changed_at DESC);

-- Enforce the state machine and write the history row in the SAME statement.
CREATE FUNCTION app.enforce_candidate_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_stage IS DISTINCT FROM OLD.current_stage THEN
    IF NOT app.candidate_stage_transition_allowed(OLD.current_stage, NEW.current_stage) THEN
      RAISE EXCEPTION 'candidate stage transition % -> % is not allowed', OLD.current_stage, NEW.current_stage
        USING ERRCODE = 'HT003';
    END IF;
    IF app.candidate_stage_needs_reason(OLD.current_stage, NEW.current_stage) AND app.current_reason() IS NULL THEN
      RAISE EXCEPTION 'candidate stage transition % -> % requires a reason', OLD.current_stage, NEW.current_stage
        USING ERRCODE = 'HT003';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_candidates_stage_guard BEFORE UPDATE OF current_stage ON candidates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_candidate_stage();

CREATE FUNCTION app.record_candidate_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.current_stage IS DISTINCT FROM OLD.current_stage THEN
    INSERT INTO candidate_stage_history (tenant_id, candidate_id, from_stage, to_stage, reason, actor_user_id)
    VALUES (NEW.tenant_id, NEW.id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_stage END,
            NEW.current_stage, app.current_reason(), app.current_user_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_candidates_stage_history AFTER INSERT OR UPDATE OF current_stage ON candidates
  FOR EACH ROW EXECUTE FUNCTION app.record_candidate_stage();

CREATE TABLE candidate_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('note', 'call', 'email', 'meeting', 'follow_up', 'system')),
  body text NOT NULL,
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_activities_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id)
);
CREATE INDEX ix_candidate_activities_candidate ON candidate_activities (tenant_id, candidate_id, created_at DESC);

SELECT app.apply_tenant_rls('clients');
SELECT app.apply_tenant_rls('job_requirements');
SELECT app.apply_tenant_rls('candidates');
SELECT app.apply_tenant_rls('candidate_compensation');
SELECT app.apply_tenant_rls('candidate_stage_history', 'append_only');
SELECT app.apply_tenant_rls('candidate_activities');
