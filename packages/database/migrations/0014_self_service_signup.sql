-- Self-service sign-up: a person who has signed in (Google or any OIDC provider) picks a plan and creates their own
-- company. No payment link, no operator approval, no e-mail needed. Replaces the request/approve flow of 0013.
--
-- Public plans are now: Free (small teams), Pro (paid) and Customize (tailored). "Plus" is retired but kept for history.
INSERT INTO plans (code, name, max_active_employees, max_branches, monthly_price, features) VALUES
  ('free', 'Free', 10, 1, 0.00, '{"payroll": false}')
ON CONFLICT (code) DO NOTHING;
UPDATE plans SET active = false WHERE code = 'plus';

-- Creates a company for a user who has none, makes them its company administrator and starts the plan's subscription.
-- Everything happens in ONE transaction (the caller's), so a failure leaves nothing half-built.
--
-- SECURITY DEFINER because the runtime role may not create tenants, grant roles or write subscriptions. The user is
-- authorised by nothing but their own identity and the new company is empty and theirs alone: there is no way to use
-- this function to touch an existing company. `p_roles` carries the system role definitions from packages/authz
-- ([{key, name, permissions[]}]); the API sends them so the SQL never has to duplicate the role catalogue.
CREATE FUNCTION app.create_company_for_user(p_user_id uuid, p_company_name text, p_plan_code text, p_roles jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan public.plans%ROWTYPE;
  v_name text := btrim(p_company_name);
  v_tenant uuid;
  v_slug text;
  v_role jsonb;
  v_role_id uuid;
  v_admin_role uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'user not found or disabled' USING ERRCODE = 'HT003';
  END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'company name must be 2-200 characters' USING ERRCODE = 'HT003';
  END IF;
  SELECT * INTO v_plan FROM public.plans WHERE code = p_plan_code AND active;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'unknown plan' USING ERRCODE = 'HT003';
  END IF;
  IF p_roles IS NULL OR jsonb_typeof(p_roles) <> 'array' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_roles) r WHERE r->>'key' = 'company_admin') THEN
    RAISE EXCEPTION 'role definitions must include company_admin' USING ERRCODE = 'HT003';
  END IF;

  -- URL-safe slug: the name in lower case plus a random suffix, so two companies may share a name.
  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  v_slug := left(CASE WHEN v_slug = '' THEN 'company' ELSE v_slug END, 30);
  v_slug := trim(both '-' from v_slug) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  INSERT INTO public.tenants (slug, legal_name, display_name, status) VALUES (v_slug, v_name, v_name, 'active') RETURNING id INTO v_tenant;

  -- Act as the new company with NO acting user, so the "no self-grant" guards do not apply to the creator's own admin role.
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.change_reason', 'company created by its first administrator', true);

  FOR v_role IN SELECT * FROM jsonb_array_elements(p_roles) LOOP
    INSERT INTO public.roles (tenant_id, role_key, name, is_system_role)
    VALUES (v_tenant, v_role->>'key', v_role->>'name', true) RETURNING id INTO v_role_id;
    INSERT INTO public.role_permissions (tenant_id, role_id, permission_key)
      SELECT v_tenant, v_role_id, p FROM jsonb_array_elements_text(v_role->'permissions') AS p;
    IF v_role->>'key' = 'company_admin' THEN v_admin_role := v_role_id; END IF;
  END LOOP;

  INSERT INTO public.tenant_memberships (tenant_id, user_id, status, branch_scope_mode, joined_at)
  VALUES (v_tenant, p_user_id, 'active', 'all', now());
  INSERT INTO public.membership_roles (tenant_id, user_id, role_id) VALUES (v_tenant, p_user_id, v_admin_role);

  -- No payment is collected here. Free is simply active; Pro and Customize start as a 14-day trial.
  INSERT INTO public.subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  VALUES (v_tenant, v_plan.id,
          CASE WHEN v_plan.code = 'free' THEN 'active' ELSE 'trialing' END,
          CASE WHEN v_plan.code = 'free' THEN NULL ELSE now() + interval '14 days' END,
          current_date,
          CASE WHEN v_plan.code = 'free' THEN NULL ELSE (current_date + interval '14 days')::date END);

  PERFORM set_config('app.user_id', p_user_id::text, true);
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, source)
  VALUES (v_tenant, p_user_id, 'company.self_signup', 'tenants', v_tenant, 'api');
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION app.create_company_for_user(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_company_for_user(uuid, text, text, jsonb) TO humantech_app;
