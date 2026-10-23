-- 0001_foundation.sql
-- Platform identity, tenancy, organisation structure, RBAC and the helper
-- functions every later migration relies on.
--
-- Roles (created by `pnpm db:bootstrap`, NOT by migrations - they are cluster objects):
--   humantech_owner   owns all objects, runs migrations. NOSUPERUSER NOBYPASSRLS.
--   humantech_app     runtime role used by API + job handlers. Subject to RLS.
--   humantech_system  platform/dispatcher role. Subject to RLS; only sees what an
--                     explicit TO humantech_system policy allows.
--
-- Error codes raised by triggers (mapped to API error codes by the API layer):
--   HT001 append-only violation       HT004 maker-checker violation
--   HT002 immutable record (locked)   HT005 insufficient leave balance
--   HT003 invalid state transition    HT006 locked period / cutoff

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO humantech_app, humantech_system;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO humantech_app, humantech_system;

-- -----------------------------------------------------------------------------
-- Request context. Set transaction-locally by the API AFTER membership is verified:
--   SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true);
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.current_reason() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(btrim(current_setting('app.change_reason', true)), '') $$;

-- -----------------------------------------------------------------------------
-- Generic trigger functions
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Optimistic concurrency: version increments on every real update.
CREATE FUNCTION app.touch_versioned_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE FUNCTION app.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'HT001';
END $$;

-- -----------------------------------------------------------------------------
-- Apply tenant row-level security + grants to a tenant-owned table.
--   mode 'crud'        : SELECT, INSERT, UPDATE, DELETE
--   mode 'append_only' : SELECT, INSERT (plus a trigger refusing UPDATE/DELETE/TRUNCATE
--                        for every role, including the owner)
-- The owner role is included so SECURITY DEFINER provisioning functions work under FORCE RLS;
-- it is still bound to the transaction's tenant context (it has no BYPASSRLS).
-- Every table that has a tenant_id column MUST call this. A schema-lint test enforces it.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.apply_tenant_rls(p_table regclass, p_mode text DEFAULT 'crud')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_name text := (SELECT relname FROM pg_class WHERE oid = p_table);
BEGIN
  IF p_mode NOT IN ('crud', 'append_only') THEN
    RAISE EXCEPTION 'unknown RLS mode %', p_mode;
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO humantech_app, humantech_owner '
    'USING (tenant_id = app.current_tenant_id()) '
    'WITH CHECK (tenant_id = app.current_tenant_id())', p_table);

  IF p_mode = 'crud' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO humantech_app', p_table);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT ON %s TO humantech_app', p_table);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %s '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', v_name, p_table);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', v_name, p_table);
  END IF;
END $$;

-- =============================================================================
-- Global platform identity and tenant catalogue
-- =============================================================================
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  registration_identifier text,
  country_code char(2) NOT NULL DEFAULT 'IN',
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'closed')),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  currency char(3) NOT NULL DEFAULT 'INR',
  fiscal_year_start_month smallint NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  -- Control-critical flags are typed columns, never buried in JSON.
  payroll_maker_checker_required boolean NOT NULL DEFAULT true,
  payroll_activated_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_subject text NOT NULL UNIQUE,
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(email_normalized)),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  email_verified_at timestamptz,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  user_agent_hash bytea,
  ip_hash bytea
);
CREATE INDEX ix_user_sessions_user_active ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Platform staff are humantech employees, never tenant users.
CREATE TABLE platform_staff (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  staff_role text NOT NULL CHECK (staff_role IN ('platform_admin', 'support', 'billing', 'security')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  permission_key text PRIMARY KEY CHECK (permission_key ~ '^[a-z_]+\.[a-z_]+$'),
  domain text NOT NULL,
  description text NOT NULL,
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive', 'critical'))
);

-- =============================================================================
-- Tenant structure
-- =============================================================================
CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text,
  state_code text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_branches_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_branches_tenant_code UNIQUE (tenant_id, code)
);
CREATE INDEX ix_branches_tenant_status ON branches (tenant_id, status);
CREATE TRIGGER trg_branches_touch BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  -- 'all' = every branch in the tenant; 'listed' = only membership_branch_scopes rows.
  branch_scope_mode text NOT NULL DEFAULT 'listed' CHECK (branch_scope_mode IN ('all', 'listed')),
  default_branch_id uuid,
  -- Bumped whenever roles/scopes change; lets caches and sessions detect stale grants.
  permission_version integer NOT NULL DEFAULT 1,
  invited_by uuid REFERENCES users(id),
  joined_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT fk_membership_default_branch FOREIGN KEY (tenant_id, default_branch_id)
    REFERENCES branches (tenant_id, id)
);
CREATE INDEX ix_memberships_user_status ON tenant_memberships (user_id, status);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_departments_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_departments_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_designations_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_designations_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE cost_centres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_cost_centres_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_cost_centres_tenant_code UNIQUE (tenant_id, code)
);

-- =============================================================================
-- RBAC: roles, grants, branch scope
-- =============================================================================
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_key text NOT NULL CHECK (role_key ~ '^[a-z_]+$'),
  name text NOT NULL,
  is_system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_roles_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_roles_tenant_key UNIQUE (tenant_id, role_key)
);

CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL REFERENCES permissions(permission_key),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE membership_roles (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE membership_branch_scopes (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, branch_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

-- Privilege-escalation guard: a user can never grant a role to their own membership.
CREATE FUNCTION app.forbid_self_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id = app.current_user_id() THEN
    RAISE EXCEPTION 'a user cannot change their own roles or scope'
      USING ERRCODE = 'HT004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_membership_roles_no_self_grant BEFORE INSERT OR UPDATE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION app.forbid_self_grant();
CREATE TRIGGER trg_membership_scopes_no_self_grant BEFORE INSERT OR UPDATE ON membership_branch_scopes
  FOR EACH ROW EXECUTE FUNCTION app.forbid_self_grant();

CREATE FUNCTION app.forbid_self_membership_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id = app.current_user_id()
     AND (NEW.status, NEW.branch_scope_mode) IS DISTINCT FROM (OLD.status, OLD.branch_scope_mode) THEN
    RAISE EXCEPTION 'a user cannot change their own membership status or branch scope'
      USING ERRCODE = 'HT004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_memberships_no_self_change BEFORE UPDATE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.forbid_self_membership_change();

-- Roles are bumped to a new permission_version whenever grants change.
CREATE FUNCTION app.bump_permission_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  UPDATE tenant_memberships SET permission_version = permission_version + 1
   WHERE tenant_id = r.tenant_id AND user_id = r.user_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_membership_roles_bump AFTER INSERT OR UPDATE OR DELETE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION app.bump_permission_version();
CREATE TRIGGER trg_membership_scopes_bump AFTER INSERT OR UPDATE OR DELETE ON membership_branch_scopes
  FOR EACH ROW EXECUTE FUNCTION app.bump_permission_version();

-- =============================================================================
-- Invitations
-- =============================================================================
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  token_hash bytea NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  branch_scope_mode text NOT NULL DEFAULT 'listed' CHECK (branch_scope_mode IN ('all', 'listed')),
  invited_by uuid REFERENCES users(id),
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invitations_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_invitations_idempotency UNIQUE (tenant_id, idempotency_key)
);
CREATE UNIQUE INDEX uq_invitations_one_pending ON invitations (tenant_id, email_normalized) WHERE status = 'pending';

CREATE TABLE invitation_roles (
  tenant_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, invitation_id, role_id),
  FOREIGN KEY (tenant_id, invitation_id) REFERENCES invitations (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE invitation_branch_scopes (
  tenant_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, invitation_id, branch_id),
  FOREIGN KEY (tenant_id, invitation_id) REFERENCES invitations (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

-- =============================================================================
-- Time-limited, purpose-bound support access (no unlogged "switch into any company")
-- =============================================================================
CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  staff_user_id uuid NOT NULL REFERENCES platform_staff(user_id),
  ticket_reference text NOT NULL,
  reason text NOT NULL,
  approved_by uuid REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_support_grants_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ck_support_grant_window CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '8 hours'),
  CONSTRAINT ck_support_grant_needs_approval CHECK (approved_by IS NOT NULL AND approved_by <> staff_user_id)
);

-- =============================================================================
-- Row-level security
-- =============================================================================
-- Tenant-owned tables: strictly the verified tenant context.
SELECT app.apply_tenant_rls('branches');
SELECT app.apply_tenant_rls('tenant_memberships');
SELECT app.apply_tenant_rls('departments');
SELECT app.apply_tenant_rls('designations');
SELECT app.apply_tenant_rls('cost_centres');
SELECT app.apply_tenant_rls('roles');
SELECT app.apply_tenant_rls('role_permissions');
SELECT app.apply_tenant_rls('membership_roles');
SELECT app.apply_tenant_rls('membership_branch_scopes');
SELECT app.apply_tenant_rls('invitations');
SELECT app.apply_tenant_rls('invitation_roles');
SELECT app.apply_tenant_rls('invitation_branch_scopes');
SELECT app.apply_tenant_rls('support_access_grants');
REVOKE INSERT, UPDATE, DELETE ON support_access_grants FROM humantech_app;  -- platform-only writes

-- tenant_memberships also needs to be readable by the user it belongs to, so the API can
-- list "which companies can I enter?" BEFORE a tenant context exists.
CREATE POLICY own_memberships_read ON tenant_memberships AS PERMISSIVE FOR SELECT TO humantech_app
  USING (user_id = app.current_user_id());

-- Global tables. A user sees their own row and, inside a verified tenant context, the
-- rows of that tenant's members. identity_subject is never granted to the runtime role.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_or_teammate_read ON users AS PERMISSIVE FOR SELECT TO humantech_app
  USING (
    id = app.current_user_id()
    OR id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id = app.current_tenant_id())
  );
CREATE POLICY self_update ON users AS PERMISSIVE FOR UPDATE TO humantech_app
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());
GRANT SELECT (id, email_normalized, display_name, status, email_verified_at, mfa_enrolled, last_login_at, created_at)
  ON users TO humantech_app;
GRANT UPDATE (display_name, mfa_enrolled, last_login_at) ON users TO humantech_app;

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON user_sessions AS PERMISSIVE FOR ALL TO humantech_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
GRANT SELECT, INSERT, UPDATE ON user_sessions TO humantech_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY visible_tenants ON tenants AS PERMISSIVE FOR SELECT TO humantech_app
  USING (
    id = app.current_tenant_id()
    OR id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = app.current_user_id() AND status = 'active')
  );
CREATE POLICY own_tenant_update ON tenants AS PERMISSIVE FOR UPDATE TO humantech_app
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());
GRANT SELECT ON tenants TO humantech_app;
GRANT UPDATE (display_name, timezone, settings, registration_identifier, fiscal_year_start_month) ON tenants TO humantech_app;

-- Platform role sees tenants/users/staff for provisioning and billing only.
CREATE POLICY system_all ON tenants AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON users AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON tenants, users TO humantech_system;
GRANT SELECT, INSERT, UPDATE ON platform_staff TO humantech_system;
CREATE POLICY system_all ON support_access_grants AS PERMISSIVE FOR ALL TO humantech_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON support_access_grants TO humantech_system;
GRANT SELECT ON permissions TO humantech_app, humantech_system;

-- =============================================================================
-- Identity bootstrap (SECURITY DEFINER): the only way a login can be resolved
-- before a user context exists. They return minimal data and never list users.
-- =============================================================================
CREATE FUNCTION app.resolve_identity(p_subject text)
RETURNS TABLE (user_id uuid, status text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.status FROM public.users u WHERE u.identity_subject = p_subject
$$;

CREATE FUNCTION app.upsert_user_from_identity(
  p_subject text, p_email text, p_display_name text, p_email_verified boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.users (identity_subject, email_normalized, display_name, email_verified_at, last_login_at)
  VALUES (p_subject, lower(btrim(p_email)), p_display_name, CASE WHEN p_email_verified THEN now() END, now())
  ON CONFLICT (identity_subject) DO UPDATE
     SET last_login_at = now(),
         email_verified_at = COALESCE(public.users.email_verified_at, EXCLUDED.email_verified_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.resolve_identity(text), app.upsert_user_from_identity(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_identity(text), app.upsert_user_from_identity(text, text, text, boolean)
  TO humantech_app, humantech_system;
