-- 0007_provisioning_and_audit_triggers.sql
-- Tenant provisioning (platform-only), DB-level audit backstop, and final privilege hardening.

-- -----------------------------------------------------------------------------
-- Tenant provisioning. SECURITY DEFINER, executable ONLY by the platform (system) role.
-- Creates the tenant, the first admin membership and counters. System roles/permissions
-- are seeded by the application from the authz catalogue (single source of truth).
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.provision_tenant(
  p_slug text, p_legal_name text, p_display_name text, p_admin_user_id uuid,
  p_status text DEFAULT 'trial'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_id uuid; v_prev text := current_setting('app.tenant_id', true);
BEGIN
  INSERT INTO public.tenants (slug, legal_name, display_name, status)
  VALUES (p_slug, p_legal_name, p_display_name, p_status)
  RETURNING id INTO v_id;

  PERFORM set_config('app.tenant_id', v_id::text, true);
  INSERT INTO public.tenant_memberships (tenant_id, user_id, status, branch_scope_mode, joined_at)
  VALUES (v_id, p_admin_user_id, 'active', 'all', now());
  PERFORM set_config('app.tenant_id', COALESCE(v_prev, ''), true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.provision_tenant(text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_tenant(text, text, text, uuid, text) TO humantech_system;

-- -----------------------------------------------------------------------------
-- Backstop audit on the tables where a missed audit entry would hurt most.
-- Ciphertext columns are redacted before they ever reach the log.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_audit_salary_assignments AFTER INSERT OR UPDATE OR DELETE ON employee_salary_assignments
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_bank_details AFTER INSERT OR UPDATE OR DELETE ON employee_bank_details
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('account_number_ciphertext', 'ifsc_ciphertext');
CREATE TRIGGER trg_audit_identifiers AFTER INSERT OR UPDATE OR DELETE ON employee_identifiers
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('value_ciphertext', 'blind_index');
CREATE TRIGGER trg_audit_membership_roles AFTER INSERT OR UPDATE OR DELETE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_membership_scopes AFTER INSERT OR UPDATE OR DELETE ON membership_branch_scopes
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_payroll_runs AFTER INSERT OR UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_payroll_adjustments AFTER INSERT OR UPDATE OR DELETE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_leave_adjustments AFTER INSERT ON leave_balance_transactions
  FOR EACH ROW WHEN (NEW.transaction_type = 'manual_adjustment') EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_employee_exits AFTER INSERT OR UPDATE ON employee_exits
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
CREATE TRIGGER trg_audit_tenant_membership AFTER INSERT OR UPDATE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- -----------------------------------------------------------------------------
-- Hardening: nothing is executable by PUBLIC; sequences/functions are opt-in.
-- -----------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO humantech_app;
-- Platform-only functions stay platform-only.
REVOKE EXECUTE ON FUNCTION app.provision_tenant(text, text, text, uuid, text) FROM humantech_app;
REVOKE EXECUTE ON FUNCTION app.claim_outbox_events(integer, text, interval),
                           app.complete_outbox_event(uuid, text),
                           app.fail_outbox_event(uuid, text, text, text, boolean) FROM humantech_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO humantech_system;
