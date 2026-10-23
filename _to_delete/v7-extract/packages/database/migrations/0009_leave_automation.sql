-- 0009_leave_automation.sql
-- (1) Leave types that need no approval are auto-approved by the system, which the original decision
--     constraint/self-decision trigger could not express without inventing a fake approver.
-- (2) Idempotent accrual and year-end expiry as set-based SQL so the API and the worker share one rule.

ALTER TABLE leave_requests ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
ALTER TABLE leave_requests DROP CONSTRAINT ck_leave_decision;
ALTER TABLE leave_requests ADD CONSTRAINT ck_leave_decision CHECK (
  status NOT IN ('approved', 'rejected')
  OR (auto_approved AND status = 'approved' AND decided_at IS NOT NULL)
  OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));

CREATE OR REPLACE FUNCTION app.guard_leave_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'leave request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'HT003';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NOT NEW.auto_approved AND NEW.decided_by IS NOT DISTINCT FROM (
       SELECT e.user_id FROM employees e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.employee_id) THEN
    RAISE EXCEPTION 'an employee cannot decide their own leave request' USING ERRCODE = 'HT004';
  END IF;
  RETURN NEW;
END $$;

-- Grants accrual_days per policy period to every eligible employee of the CURRENT tenant.
-- Re-running for the same period is a no-op (idempotency key). Returns the number of grants made.
CREATE FUNCTION app.accrue_leave(p_as_of date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  IF app.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  INSERT INTO leave_balance_transactions
    (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, reason, idempotency_key, actor_user_id)
  SELECT d.tenant_id, d.employee_id, d.leave_type_id, 'accrual', d.accrual_days, d.eff,
         'Scheduled accrual ' || d.period, 'accrual:' || d.employee_id || ':' || d.leave_type_id || ':' || d.period, app.current_user_id()
    FROM (
      SELECT e.tenant_id, e.id AS employee_id, p.leave_type_id, p.accrual_days,
             CASE p.accrual_frequency WHEN 'monthly' THEN to_char(p_as_of, 'YYYY-MM')
                                      WHEN 'quarterly' THEN to_char(p_as_of, 'YYYY-"Q"Q')
                                      WHEN 'yearly' THEN to_char(p_as_of, 'YYYY') ELSE 'joining' END AS period,
             GREATEST(e.joined_at, CASE p.accrual_frequency WHEN 'monthly' THEN date_trunc('month', p_as_of)::date
                                      WHEN 'quarterly' THEN date_trunc('quarter', p_as_of)::date
                                      WHEN 'yearly' THEN date_trunc('year', p_as_of)::date ELSE e.joined_at END) AS eff
        FROM employees e
        JOIN leave_policies p ON p.tenant_id = e.tenant_id AND p.status = 'active'
             AND p_as_of BETWEEN p.effective_from AND COALESCE(p.effective_to, 'infinity'::date)
             AND p.accrual_frequency <> 'none' AND p.accrual_days > 0
        JOIN leave_types t ON t.tenant_id = p.tenant_id AND t.id = p.leave_type_id AND t.active
       WHERE e.tenant_id = app.current_tenant_id()
         AND e.employment_status IN ('active', 'probation', 'on_notice')
         AND (e.employment_status <> 'probation' OR p.probation_eligible)
         AND e.joined_at IS NOT NULL AND e.joined_at <= p_as_of
         AND (p_as_of - e.joined_at) >= p.eligible_after_days
    ) d
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Year-end: whatever exceeds the policy's carry-forward cap lapses on 31 December of p_year.
CREATE FUNCTION app.expire_leave(p_year integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer; v_end date := make_date(p_year, 12, 31);
BEGIN
  IF app.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  INSERT INTO leave_balance_transactions
    (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, reason, idempotency_key, actor_user_id)
  SELECT b.tenant_id, b.employee_id, b.leave_type_id, 'expiry', -(b.bal - LEAST(b.bal, p.carry_forward_max_days)), v_end,
         'Year-end lapse beyond carry-forward cap', 'expiry:' || b.employee_id || ':' || b.leave_type_id || ':' || p_year, app.current_user_id()
    FROM (
      SELECT tenant_id, employee_id, leave_type_id, SUM(days_delta) AS bal
        FROM leave_balance_transactions
       WHERE tenant_id = app.current_tenant_id() AND effective_date <= v_end
       GROUP BY 1, 2, 3
    ) b
    JOIN leave_policies p ON p.tenant_id = b.tenant_id AND p.leave_type_id = b.leave_type_id AND p.status = 'active'
         AND v_end BETWEEN p.effective_from AND COALESCE(p.effective_to, 'infinity'::date)
   WHERE b.bal > p.carry_forward_max_days
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION app.accrue_leave(date), app.expire_leave(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accrue_leave(date), app.expire_leave(integer) TO humantech_app;
