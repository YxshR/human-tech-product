-- 0008_invitation_acceptance.sql
-- An invitee is not yet a member, so RLS (correctly) hides the invitation from them. Acceptance is
-- therefore a narrowly-scoped SECURITY DEFINER function: it looks the invitation up by the hash of the
-- secret token, checks status/expiry/e-mail, and creates the membership + roles + branch scopes.

-- Owner-only lookup path, switched on transaction-locally by the function and nothing else.
CREATE POLICY invitation_token_lookup ON invitations AS PERMISSIVE FOR SELECT TO humantech_owner
  USING (current_setting('app.invite_lookup', true) = 'on');

CREATE FUNCTION app.accept_invitation(p_token_hash bytea, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv public.invitations%ROWTYPE;
  v_user_email text;
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_prev_user text := current_setting('app.user_id', true);
BEGIN
  PERFORM set_config('app.invite_lookup', 'on', true);
  SELECT * INTO v_inv FROM public.invitations WHERE token_hash = p_token_hash;
  PERFORM set_config('app.invite_lookup', '', true);
  -- PERFORM resets FOUND, so test the row itself.
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'HT003';
  END IF;

  -- Everything below is authorised by the inviter, not by the invitee (no self-grant).
  PERFORM set_config('app.tenant_id', v_inv.tenant_id::text, true);
  PERFORM set_config('app.user_id', COALESCE(v_inv.invited_by::text, ''), true);

  -- Re-read under the tenant policy WITH a row lock so two concurrent accepts serialise.
  SELECT * INTO v_inv FROM public.invitations WHERE id = v_inv.id AND tenant_id = v_inv.tenant_id FOR UPDATE;

  SELECT email_normalized INTO v_user_email FROM public.users WHERE id = p_user_id AND status = 'active';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'user not found or disabled' USING ERRCODE = 'HT003';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'invitation is %', v_inv.status USING ERRCODE = 'HT003';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'invitation has expired' USING ERRCODE = 'HT003';
  END IF;
  IF v_inv.email_normalized <> v_user_email THEN
    RAISE EXCEPTION 'invitation was sent to a different e-mail address' USING ERRCODE = 'HT003';
  END IF;

  INSERT INTO public.tenant_memberships (tenant_id, user_id, status, branch_scope_mode, invited_by, joined_at)
  VALUES (v_inv.tenant_id, p_user_id, 'active', v_inv.branch_scope_mode, v_inv.invited_by, now())
  ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET status = 'active', branch_scope_mode = EXCLUDED.branch_scope_mode, revoked_at = NULL, joined_at = now()
    WHERE public.tenant_memberships.status IN ('removed', 'invited');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user is already a member of this company' USING ERRCODE = 'HT003';
  END IF;

  INSERT INTO public.membership_roles (tenant_id, user_id, role_id)
    SELECT v_inv.tenant_id, p_user_id, role_id FROM public.invitation_roles WHERE invitation_id = v_inv.id AND tenant_id = v_inv.tenant_id
    ON CONFLICT DO NOTHING;
  INSERT INTO public.membership_branch_scopes (tenant_id, user_id, branch_id)
    SELECT v_inv.tenant_id, p_user_id, branch_id FROM public.invitation_branch_scopes WHERE invitation_id = v_inv.id AND tenant_id = v_inv.tenant_id
    ON CONFLICT DO NOTHING;
  UPDATE public.invitations SET status = 'accepted', accepted_at = now(), accepted_user_id = p_user_id
   WHERE id = v_inv.id AND tenant_id = v_inv.tenant_id;

  PERFORM set_config('app.user_id', p_user_id::text, true);
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, source)
  VALUES (v_inv.tenant_id, p_user_id, 'invitation.accept', 'invitations', v_inv.id, 'api');

  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
  PERFORM set_config('app.user_id', COALESCE(v_prev_user, ''), true);
  RETURN v_inv.tenant_id;
END $$;
REVOKE ALL ON FUNCTION app.accept_invitation(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(bytea, uuid) TO humantech_app;
