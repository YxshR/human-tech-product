-- 0015_password_login.sql
-- Sign-in with an e-mail address and a password, for people who have no work account at an identity provider.
--
-- How a person gets one:
--   1. Someone allowed to (`employee.issue_login`) creates a LOGIN CODE for an employee: an invitation of kind 'code'.
--      Only the hash of the code is stored. The code is shown once and handed over by the company, with the sign-in address.
--   2. The person enters e-mail + code and chooses a password. That creates their user, stores the password hash,
--      makes them a member with the roles chosen in step 1 and links them to their employee record. The code is spent.
--   3. From then on they sign in with e-mail + password.
--   Forgotten password: the company issues a code of kind 'reset' for that employee; the same screen then replaces the
--   password. A reset code never creates an account, a membership or a role.
--
-- Password hashes live in their own table that the application role cannot read or write at all: every touch goes
-- through the narrow SECURITY DEFINER functions below.

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_set_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON user_credentials FROM PUBLIC;

ALTER TABLE invitations
  ADD COLUMN kind text NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'code', 'reset')),
  ADD COLUMN employee_id uuid,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT fk_invitation_employee FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id);
CREATE INDEX ix_invitations_employee ON invitations (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

INSERT INTO permissions (permission_key, domain, description, sensitivity)
VALUES ('employee.issue_login', 'employee', 'Create a login code so an employee can sign in', 'sensitive')
ON CONFLICT (permission_key) DO NOTHING;

-- ---- sign in ------------------------------------------------------------------------------------------------------
CREATE FUNCTION app.password_login_find(p_email text)
RETURNS TABLE (user_id uuid, identity_subject text, display_name text, password_hash text, status text, locked boolean)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.identity_subject, u.display_name, c.password_hash, u.status, COALESCE(c.locked_until > now(), false)
    FROM public.users u JOIN public.user_credentials c ON c.user_id = u.id
   WHERE u.email_normalized = lower(btrim(p_email))
$$;

-- Five wrong passwords in a row lock the account for 15 minutes.
CREATE FUNCTION app.password_login_record(p_user_id uuid, p_ok boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_ok THEN
    UPDATE public.user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;
    UPDATE public.users SET last_login_at = now() WHERE id = p_user_id;
  ELSE
    UPDATE public.user_credentials
       SET locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END
     WHERE user_id = p_user_id;
  END IF;
END $$;

-- ---- first sign-in: spend the code, set the password -----------------------------------------------------------------
-- Returns no row when the e-mail + code pair is wrong (and counts the miss: five misses cancel the code). It returns
-- instead of raising so that the count survives. Everything else that can go wrong raises HT003 and changes nothing.
CREATE FUNCTION app.activate_login_code(p_email text, p_code_hash bytea, p_password_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, identity_subject text, display_name text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(p_email));
  v_inv public.invitations%ROWTYPE;
  v_miss record;
  v_user uuid := gen_random_uuid();
  v_name text;
  v_tenant uuid;
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_user text := current_setting('app.user_id', true);
  v_prev_reason text := current_setting('app.change_reason', true);
BEGIN
  PERFORM set_config('app.invite_lookup', 'on', true);
  SELECT * INTO v_inv FROM public.invitations
   WHERE token_hash = p_code_hash AND email_normalized = v_email AND kind IN ('code', 'reset') AND status = 'pending';

  IF v_inv.id IS NULL THEN
    FOR v_miss IN SELECT i.id, i.tenant_id FROM public.invitations i
                   WHERE i.email_normalized = v_email AND i.kind IN ('code', 'reset') AND i.status = 'pending' LOOP
      PERFORM set_config('app.tenant_id', v_miss.tenant_id::text, true);
      UPDATE public.invitations
         SET failed_attempts = failed_attempts + 1,
             status = CASE WHEN failed_attempts + 1 >= 5 THEN 'revoked' ELSE status END
       WHERE invitations.id = v_miss.id AND invitations.tenant_id = v_miss.tenant_id;
    END LOOP;
    PERFORM set_config('app.invite_lookup', '', true);
    PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
    RETURN;
  END IF;
  PERFORM set_config('app.invite_lookup', '', true);

  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'login code has expired' USING ERRCODE = 'HT003';
  END IF;

  -- Forgotten password: only for the password account already linked to this very employee, in this very company.
  IF v_inv.kind = 'reset' THEN
    PERFORM set_config('app.tenant_id', v_inv.tenant_id::text, true);
    PERFORM set_config('app.user_id', COALESCE(v_inv.invited_by::text, ''), true);
    SELECT u.id, u.display_name INTO v_user, v_name
      FROM public.employees e
      JOIN public.users u ON u.id = e.user_id
      JOIN public.user_credentials c ON c.user_id = u.id
      JOIN public.tenant_memberships m ON m.tenant_id = e.tenant_id AND m.user_id = u.id AND m.status = 'active'
     WHERE e.tenant_id = v_inv.tenant_id AND e.id = v_inv.employee_id
       AND u.email_normalized = v_email AND u.status = 'active' AND u.identity_subject LIKE 'local:%';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'this employee can no longer be given a login' USING ERRCODE = 'HT003';
    END IF;
    UPDATE public.user_credentials
       SET password_hash = p_password_hash, failed_attempts = 0, locked_until = NULL, password_set_at = now()
     WHERE user_credentials.user_id = v_user;
    UPDATE public.invitations SET status = 'accepted', accepted_at = now(), accepted_user_id = v_user
     WHERE id = v_inv.id AND invitations.tenant_id = v_inv.tenant_id;
    PERFORM set_config('app.user_id', v_user::text, true);
    INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, source)
    VALUES (v_inv.tenant_id, v_user, 'login.password_reset', 'employees', v_inv.employee_id, 'api');
    PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
    PERFORM set_config('app.user_id', COALESCE(v_prev_user, ''), true);
    RETURN QUERY SELECT v_user, v_inv.tenant_id, 'local:' || v_user::text, v_name;
    RETURN;
  END IF;

  -- The code proves the company wants this person in; it does not prove they own an account that already exists.
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.email_normalized = v_email) THEN
    RAISE EXCEPTION 'this e-mail address already has an account' USING ERRCODE = 'HT003';
  END IF;

  PERFORM set_config('app.tenant_id', v_inv.tenant_id::text, true);
  PERFORM set_config('app.user_id', COALESCE(v_inv.invited_by::text, ''), true);
  IF v_inv.employee_id IS NOT NULL THEN
    SELECT btrim(concat_ws(' ', e.first_name, e.last_name)) INTO v_name
      FROM public.employees e WHERE e.tenant_id = v_inv.tenant_id AND e.id = v_inv.employee_id;
  END IF;
  v_name := COALESCE(NULLIF(v_name, ''), split_part(v_email, '@', 1));

  INSERT INTO public.users (id, identity_subject, email_normalized, display_name, last_login_at)
  VALUES (v_user, 'local:' || v_user::text, v_email, v_name, now());
  INSERT INTO public.user_credentials (user_id, password_hash) VALUES (v_user, p_password_hash);

  -- Membership, roles and branch scope exactly as the issuer chose them; marks the code as used.
  v_tenant := app.accept_invitation(p_code_hash, v_user);

  IF v_inv.employee_id IS NOT NULL THEN
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    PERFORM set_config('app.user_id', COALESCE(v_inv.invited_by::text, ''), true);
    PERFORM set_config('app.change_reason', 'login code used', true);
    UPDATE public.employees e SET user_id = v_user
     WHERE e.tenant_id = v_tenant AND e.id = v_inv.employee_id AND e.user_id IS NULL
       AND e.employment_status NOT IN ('archived', 'exited');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'this employee can no longer be given a login' USING ERRCODE = 'HT003';
    END IF;
    PERFORM set_config('app.user_id', v_user::text, true);
    INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, source)
    VALUES (v_tenant, v_user, 'employee.link_login', 'employees', v_inv.employee_id, 'api');
  END IF;

  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
  PERFORM set_config('app.user_id', COALESCE(v_prev_user, ''), true);
  PERFORM set_config('app.change_reason', COALESCE(v_prev_reason, ''), true);
  RETURN QUERY SELECT v_user, v_tenant, 'local:' || v_user::text, v_name;
END $$;

REVOKE ALL ON FUNCTION app.password_login_find(text), app.password_login_record(uuid, boolean), app.activate_login_code(text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.password_login_find(text), app.password_login_record(uuid, boolean), app.activate_login_code(text, bytea, text) TO humantech_app;
