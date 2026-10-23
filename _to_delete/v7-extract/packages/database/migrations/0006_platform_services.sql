-- 0006_platform_services.sql
-- Files, payslips, outbox/job queue, notifications, approvals, imports/exports, custom fields,
-- audit, subscriptions, invoices and privacy/retention.

-- -----------------------------------------------------------------------------
-- Private files. Object keys are server-generated and namespaced by tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE stored_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  purpose text NOT NULL CHECK (purpose IN
    ('employee_document', 'candidate_document', 'payslip', 'import_source', 'import_result', 'export_result', 'branding')),
  object_key text NOT NULL,
  original_filename text,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  checksum_sha256 text CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  object_version_id text,
  status text NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload', 'quarantined', 'clean', 'rejected', 'deleted')),
  scanned_at timestamptz,
  expires_at timestamptz,                    -- temporary artefacts (exports) expire
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stored_files_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_stored_files_object_key UNIQUE (object_key),
  -- A file can only live under its own tenant's prefix: cross-tenant keys are unrepresentable.
  CONSTRAINT ck_stored_file_key_prefix CHECK (object_key LIKE tenant_id::text || '/%')
);

CREATE TABLE file_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  file_id uuid NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('upload', 'download_url_issued', 'download', 'delete', 'denied')),
  request_id text,
  ip_hash bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files (tenant_id, id)
);
CREATE INDEX ix_file_access_file ON file_access_events (tenant_id, file_id, created_at DESC);

CREATE TABLE employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  file_id uuid NOT NULL,
  document_type text NOT NULL,
  title text,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  expires_on date,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employee_documents_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files (tenant_id, id)
);

CREATE TABLE candidate_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  file_id uuid NOT NULL,
  document_type text NOT NULL DEFAULT 'resume',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_documents_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Versioned document templates and payslips
-- -----------------------------------------------------------------------------
CREATE TABLE document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('payslip', 'offer_letter', 'invoice')),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_templates_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_document_templates_version UNIQUE (tenant_id, kind, name, version)
);

CREATE TABLE payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payroll_run_item_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  file_id uuid,
  template_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'superseded', 'revoked')),
  generated_at timestamptz,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payslip_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_payslip_run_item_revision UNIQUE (tenant_id, payroll_run_item_id, revision),
  FOREIGN KEY (tenant_id, payroll_run_item_id) REFERENCES payroll_run_items (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES stored_files (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES document_templates (tenant_id, id),
  CONSTRAINT ck_payslip_ready_has_file CHECK (status <> 'ready' OR (file_id IS NOT NULL AND generated_at IS NOT NULL))
);
CREATE INDEX ix_payslips_employee ON payslips (tenant_id, employee_id, created_at DESC);

-- A payslip may only be created from a FINALISED payroll snapshot, and must belong to the
-- same employee as the run item it renders.
CREATE FUNCTION app.guard_payslip_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_employee uuid;
BEGIN
  SELECT r.status, i.employee_id INTO v_status, v_employee
    FROM payroll_run_items i JOIN payroll_runs r ON r.tenant_id = i.tenant_id AND r.id = i.payroll_run_id
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.payroll_run_item_id;
  IF v_status IS NULL OR v_status NOT IN ('locked', 'payslips_generated') THEN
    RAISE EXCEPTION 'payslips can only be generated from a finalised payroll run' USING ERRCODE = 'HT003';
  END IF;
  IF v_employee <> NEW.employee_id THEN
    RAISE EXCEPTION 'payslip employee does not match the payroll item' USING ERRCODE = 'HT003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payslips_source BEFORE INSERT ON payslips
  FOR EACH ROW EXECUTE FUNCTION app.guard_payslip_source();

-- -----------------------------------------------------------------------------
-- Imports / exports
-- -----------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  import_type text NOT NULL CHECK (import_type IN ('employees', 'candidates', 'attendance', 'leave_balances')),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN
    ('uploaded', 'validating', 'needs_confirmation', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  source_file_id uuid NOT NULL,
  result_file_id uuid,
  source_checksum_sha256 text NOT NULL CHECK (source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version integer NOT NULL DEFAULT 1,
  total_rows integer,
  accepted_rows integer,
  rejected_rows integer,
  duplicate_policy text NOT NULL DEFAULT 'reject' CHECK (duplicate_policy IN ('reject', 'skip', 'review')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_import_job_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_file_id) REFERENCES stored_files (tenant_id, id),
  FOREIGN KEY (tenant_id, result_file_id) REFERENCES stored_files (tenant_id, id)
);
CREATE INDEX ix_import_jobs_status ON import_jobs (tenant_id, status, created_at DESC);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  import_job_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'valid', 'invalid', 'duplicate', 'committed', 'skipped')),
  raw jsonb NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_entity_id uuid,
  CONSTRAINT uq_import_row UNIQUE (tenant_id, import_job_id, row_number),
  FOREIGN KEY (tenant_id, import_job_id) REFERENCES import_jobs (tenant_id, id)
);

ALTER TABLE attendance_events
  ADD CONSTRAINT fk_attendance_event_import FOREIGN KEY (tenant_id, import_job_id) REFERENCES import_jobs (tenant_id, id);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  report_key text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  filters_hash text NOT NULL,
  -- The requester's row/field scope is frozen at request time and re-checked by the worker.
  scope_snapshot jsonb NOT NULL,
  format text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv', 'xlsx', 'pdf')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  result_file_id uuid,
  row_count integer,
  expires_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT uq_export_job_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, result_file_id) REFERENCES stored_files (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Transactional outbox = durable job queue (see ADR-0002). Business writes and the job that
-- must follow them commit atomically; workers claim rows with FOR UPDATE SKIP LOCKED.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  idempotency_key text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_outbox_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_outbox_idempotency UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ix_outbox_pending ON outbox_events (available_at, created_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE FUNCTION app.claim_outbox_events(p_limit integer, p_worker text, p_lease interval DEFAULT interval '5 minutes')
RETURNS SETOF outbox_events LANGUAGE sql AS $$
  UPDATE outbox_events e
     SET claimed_by = p_worker, claimed_at = now(), claim_expires_at = now() + p_lease, attempts = e.attempts + 1
   WHERE e.id IN (
     SELECT id FROM outbox_events
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()
        AND (claim_expires_at IS NULL OR claim_expires_at < now())
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit)
  RETURNING e.*
$$;

CREATE FUNCTION app.complete_outbox_event(p_id uuid, p_worker text) RETURNS boolean LANGUAGE sql AS $$
  WITH u AS (
    UPDATE outbox_events SET processed_at = now(), claim_expires_at = NULL
     WHERE id = p_id AND claimed_by = p_worker AND processed_at IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Transient failure: retry with exponential backoff; permanent or exhausted: dead-letter.
CREATE FUNCTION app.fail_outbox_event(p_id uuid, p_worker text, p_code text, p_message text, p_permanent boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_row outbox_events;
BEGIN
  SELECT * INTO v_row FROM outbox_events WHERE id = p_id AND claimed_by = p_worker AND processed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_claimed'; END IF;
  IF p_permanent OR v_row.attempts >= v_row.max_attempts THEN
    UPDATE outbox_events SET dead_lettered_at = now(), claim_expires_at = NULL,
           last_error_code = p_code, last_error_message = left(p_message, 1000) WHERE id = p_id;
    RETURN 'dead_lettered';
  END IF;
  UPDATE outbox_events
     SET available_at = now() + (interval '10 seconds' * power(2, LEAST(v_row.attempts, 10))),
         claim_expires_at = NULL, claimed_by = NULL,
         last_error_code = p_code, last_error_message = left(p_message, 1000)
   WHERE id = p_id;
  RETURN 'retry_scheduled';
END $$;

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  event_key text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_notifications_dedupe UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ix_notifications_recipient ON notifications (tenant_id, recipient_user_id, created_at DESC);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_id uuid,
  channel text NOT NULL CHECK (channel IN ('email')),
  recipient text NOT NULL,
  template_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error_code text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT uq_notification_delivery_idem UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notifications (tenant_id, id)
);

CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_key text NOT NULL,
  email_enabled boolean NOT NULL DEFAULT true,
  in_app_enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id, event_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Approvals (configurable but tested templates) and employee profile-change requests
-- -----------------------------------------------------------------------------
CREATE TABLE approval_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN
    ('leave_request', 'attendance_correction', 'salary_assignment', 'profile_change', 'payroll_adjustment')),
  name text NOT NULL,
  escalation_after_hours integer CHECK (escalation_after_hours > 0),
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT uq_approval_workflows_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_approval_workflows_code UNIQUE (tenant_id, code)
);

CREATE TABLE approval_workflow_steps (
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order > 0),
  approver_kind text NOT NULL CHECK (approver_kind IN ('manager', 'role', 'user')),
  role_key text,
  user_id uuid,
  PRIMARY KEY (tenant_id, workflow_id, step_order),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES approval_workflows (tenant_id, id),
  CONSTRAINT ck_approval_step_target CHECK (
    (approver_kind = 'manager' AND role_key IS NULL AND user_id IS NULL)
    OR (approver_kind = 'role' AND role_key IS NOT NULL)
    OR (approver_kind = 'user' AND user_id IS NOT NULL))
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  current_step integer NOT NULL DEFAULT 1,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT uq_approval_requests_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES approval_workflows (tenant_id, id)
);
CREATE UNIQUE INDEX uq_approval_one_open ON approval_requests (tenant_id, subject_type, subject_id) WHERE status = 'pending';
CREATE FUNCTION app.bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_approval_requests_version BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION app.bump_version();

CREATE TABLE approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  step_order integer NOT NULL,
  approver_user_id uuid REFERENCES users(id),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected', 'delegated', 'skipped')),
  decided_at timestamptz,
  comment text,
  CONSTRAINT uq_approval_step UNIQUE (tenant_id, request_id, step_order),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_requests (tenant_id, id)
);

CREATE TABLE profile_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  requested_changes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_profile_change_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CONSTRAINT ck_profile_change_reviewer CHECK (reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM requested_by)
);

-- -----------------------------------------------------------------------------
-- Typed custom fields, saved views
-- -----------------------------------------------------------------------------
CREATE TABLE custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL CHECK (entity_type IN ('candidate', 'employee', 'client', 'leave_request')),
  internal_key text NOT NULL CHECK (internal_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN
    ('short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox', 'email', 'phone', 'url')),
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible_permission text REFERENCES permissions(permission_key),
  editable_permission text REFERENCES permissions(permission_key),
  active boolean NOT NULL DEFAULT true,         -- deactivate, never delete: history is preserved
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_custom_field_def_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_custom_field_def_key UNIQUE (tenant_id, entity_type, internal_key)
);

CREATE TABLE custom_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  value_json jsonb,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_custom_field_value UNIQUE (tenant_id, definition_id, entity_type, entity_id),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES custom_field_definitions (tenant_id, id)
);
CREATE INDEX ix_custom_field_entity ON custom_field_values (tenant_id, entity_type, entity_id);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  entity_type text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL,                     -- validated against allow-listed columns/operators server-side
  is_shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_saved_views_name UNIQUE (tenant_id, owner_user_id, entity_type, name),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_memberships (tenant_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Audit (append-only for every role including the owner)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  reason text,
  before_redacted jsonb,
  after_redacted jsonb,
  request_id text,
  correlation_id text,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'worker', 'system', 'support', 'db')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_audit_logs_tenant_id UNIQUE (tenant_id, id)
);
CREATE INDEX ix_audit_entity_time ON audit_logs (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_actor_time ON audit_logs (tenant_id, actor_user_id, created_at DESC);
CREATE INDEX ix_audit_time ON audit_logs (tenant_id, created_at DESC);

-- Backstop audit written by the database itself for the most sensitive tables, so it cannot be
-- skipped by a code path that forgets to call the audit service. Column names passed as
-- trigger arguments are redacted (e.g. ciphertext).
CREATE FUNCTION app.audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb; v_after jsonb; v_row record; v_col text;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_before := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_after := to_jsonb(NEW); END IF;
  FOREACH v_col IN ARRAY COALESCE(TG_ARGV, ARRAY[]::text[]) LOOP
    IF v_before ? v_col THEN v_before := jsonb_set(v_before, ARRAY[v_col], '"[redacted]"'); END IF;
    IF v_after ? v_col THEN v_after := jsonb_set(v_after, ARRAY[v_col], '"[redacted]"'); END IF;
  END LOOP;
  INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, reason, before_redacted, after_redacted, source)
  VALUES (v_row.tenant_id, app.current_user_id(), TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
          (to_jsonb(v_row) ->> 'id')::uuid, app.current_reason(), v_before, v_after, 'db');
  RETURN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- SaaS operations: plans, subscriptions, usage, platform invoices
-- -----------------------------------------------------------------------------
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  max_active_employees integer CHECK (max_active_employees > 0),
  max_branches integer CHECK (max_branches > 0),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_price numeric(12, 2) CHECK (monthly_price >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Subscription status, payment status and entitlements are separate concepts.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  over_limit_behaviour text NOT NULL DEFAULT 'warn' CHECK (over_limit_behaviour IN ('warn', 'block_new_active_employees')),
  grace_days integer NOT NULL DEFAULT 14 CHECK (grace_days >= 0),
  employee_limit_override integer CHECK (employee_limit_override > 0),
  trial_ends_at timestamptz,
  current_period_start date,
  current_period_end date,
  cancelled_at timestamptz,
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subscriptions_tenant_id UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX uq_subscriptions_one_live ON subscriptions (tenant_id) WHERE status IN ('trialing', 'active', 'past_due');
CREATE TRIGGER trg_subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  metric text NOT NULL CHECK (metric IN ('active_employees', 'branches', 'storage_bytes', 'payslips_generated')),
  recorded_on date NOT NULL,
  value bigint NOT NULL CHECK (value >= 0),
  CONSTRAINT uq_usage_metric_day UNIQUE (tenant_id, metric, recorded_on)
);

CREATE TABLE saas_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_number text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  external_reference text,
  CONSTRAINT uq_saas_invoice_number UNIQUE (invoice_number)
);

-- -----------------------------------------------------------------------------
-- Tenant invoice generator (P2): numbering is concurrency-safe, issued invoices are immutable
-- -----------------------------------------------------------------------------
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid,
  invoice_number text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  issue_date date,
  due_date date,
  currency char(3) NOT NULL DEFAULT 'INR',
  subtotal numeric(14, 2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes text,
  issued_by uuid REFERENCES users(id),
  issued_at timestamptz,
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoices_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_invoices_number UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  CONSTRAINT ck_invoice_total CHECK (total = subtotal + tax_total),
  CONSTRAINT ck_invoice_issued CHECK (status = 'draft' OR (invoice_number IS NOT NULL AND issue_date IS NOT NULL)),
  CONSTRAINT ck_invoice_void CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  description text NOT NULL,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  tax_rate numeric(7, 4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  line_total numeric(14, 2) NOT NULL CHECK (line_total >= 0),
  CONSTRAINT uq_invoice_line UNIQUE (tenant_id, invoice_id, line_number),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  paid_on date NOT NULL,
  method text,
  reference text,
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE FUNCTION app.guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'issued invoices cannot be deleted; void them' USING ERRCODE = 'HT002';
    END IF;
    RETURN OLD;
  END IF;
  -- Number is assigned atomically at issue time.
  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    NEW.invoice_number := COALESCE(NEW.invoice_number, app.next_number('invoice', 'INV-', 6::smallint));
    NEW.issue_date := COALESCE(NEW.issue_date, current_date);
    NEW.issued_at := COALESCE(NEW.issued_at, now());
    RETURN NEW;
  END IF;
  IF OLD.status = 'issued' AND NEW.status = 'void' THEN
    NEW.voided_at := COALESCE(NEW.voided_at, now());
    IF (to_jsonb(NEW) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason']) THEN
      RAISE EXCEPTION 'voiding an invoice cannot change its content' USING ERRCODE = 'HT002';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'an issued invoice is immutable' USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice();

CREATE FUNCTION app.guard_invoice_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM invoices
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of an issued invoice are immutable' USING ERRCODE = 'HT002';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_lines();

-- -----------------------------------------------------------------------------
-- Privacy and retention (DPDP readiness)
-- -----------------------------------------------------------------------------
CREATE TABLE data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL CHECK (entity_type IN
    ('candidate', 'employee', 'payroll', 'attendance', 'audit', 'stored_file', 'notification')),
  retain_months integer NOT NULL CHECK (retain_months > 0),
  action_after text NOT NULL DEFAULT 'anonymise' CHECK (action_after IN ('anonymise', 'delete', 'archive')),
  legal_basis text,
  reviewed_by uuid REFERENCES users(id),
  CONSTRAINT uq_retention_entity UNIQUE (tenant_id, entity_type)
);

CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_employee_id uuid,
  subject_candidate_id uuid,
  request_type text NOT NULL CHECK (request_type IN ('access', 'correction', 'erasure', 'grievance')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
  details text,
  due_at timestamptz,
  handled_by uuid REFERENCES users(id),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, subject_employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_candidate_id) REFERENCES candidates (tenant_id, id),
  CONSTRAINT ck_privacy_subject CHECK (subject_employee_id IS NOT NULL OR subject_candidate_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
SELECT app.apply_tenant_rls('stored_files');
SELECT app.apply_tenant_rls('file_access_events', 'append_only');
SELECT app.apply_tenant_rls('employee_documents');
SELECT app.apply_tenant_rls('candidate_documents');
SELECT app.apply_tenant_rls('document_templates');
SELECT app.apply_tenant_rls('payslips');
SELECT app.apply_tenant_rls('import_jobs');
SELECT app.apply_tenant_rls('import_rows');
SELECT app.apply_tenant_rls('export_jobs');
SELECT app.apply_tenant_rls('outbox_events');
SELECT app.apply_tenant_rls('notifications');
SELECT app.apply_tenant_rls('notification_deliveries');
SELECT app.apply_tenant_rls('notification_preferences');
SELECT app.apply_tenant_rls('approval_workflows');
SELECT app.apply_tenant_rls('approval_workflow_steps');
SELECT app.apply_tenant_rls('approval_requests');
SELECT app.apply_tenant_rls('approval_steps');
SELECT app.apply_tenant_rls('profile_change_requests');
SELECT app.apply_tenant_rls('custom_field_definitions');
SELECT app.apply_tenant_rls('custom_field_values');
SELECT app.apply_tenant_rls('saved_views');
SELECT app.apply_tenant_rls('audit_logs', 'append_only');
SELECT app.apply_tenant_rls('subscriptions');
SELECT app.apply_tenant_rls('usage_records');
SELECT app.apply_tenant_rls('saas_invoices');
SELECT app.apply_tenant_rls('invoices');
SELECT app.apply_tenant_rls('invoice_lines');
SELECT app.apply_tenant_rls('invoice_payments');
SELECT app.apply_tenant_rls('data_retention_policies');
SELECT app.apply_tenant_rls('privacy_requests');

-- Platform-owned data: tenants may READ their own subscription/usage/billing, never write it.
REVOKE INSERT, UPDATE, DELETE ON subscriptions, usage_records, saas_invoices FROM humantech_app;
CREATE POLICY system_all ON subscriptions AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON usage_records AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON saas_invoices AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON subscriptions, usage_records, saas_invoices TO humantech_system;
GRANT SELECT ON plans TO humantech_app, humantech_system;
GRANT INSERT, UPDATE ON plans TO humantech_system;

-- The job queue: handlers (app role) may enqueue and read; only the dispatcher (system role)
-- claims, completes and fails events. App code therefore cannot cancel or tamper with jobs.
REVOKE UPDATE, DELETE ON outbox_events FROM humantech_app;
CREATE POLICY system_all ON outbox_events AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON outbox_events TO humantech_system;
GRANT EXECUTE ON FUNCTION app.claim_outbox_events(integer, text, interval),
                          app.complete_outbox_event(uuid, text),
                          app.fail_outbox_event(uuid, text, text, text, boolean) TO humantech_system;
