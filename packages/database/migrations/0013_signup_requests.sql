-- Public sign-up requests: someone picks a plan on the website and asks for a company. Not tenant data, so no RLS:
-- the runtime role may only INSERT (it cannot read anyone's request back); the platform (system) role reviews them.
CREATE TABLE signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code text NOT NULL CHECK (plan_code IN ('plus', 'pro', 'customize')),
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 2 AND 200),
  contact_name text NOT NULL CHECK (length(contact_name) BETWEEN 2 AND 120),
  email_normalized text NOT NULL CHECK (email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND length(email_normalized) <= 254),
  phone text CHECK (phone IS NULL OR length(phone) <= 32),
  employee_count integer CHECK (employee_count IS NULL OR employee_count BETWEEN 1 AND 1000000),
  message text CHECK (message IS NULL OR length(message) <= 1000),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'approved', 'rejected')),
  company_id uuid REFERENCES tenants(id),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Re-submitting the same request while it is still open does nothing (and tells the sender nothing about it).
CREATE UNIQUE INDEX uq_signup_open ON signup_requests (email_normalized, plan_code) WHERE status = 'awaiting_payment';
GRANT INSERT ON signup_requests TO humantech_app;
GRANT SELECT, UPDATE ON signup_requests TO humantech_system;

-- The three public plans. Prices are what the website shows; change them here (and in apps/web/src/lib/plans.ts) to suit.
INSERT INTO plans (code, name, max_active_employees, max_branches, monthly_price, features) VALUES
  ('plus', 'Plus', 50, 3, 4999.00, '{"payroll": false}'),
  ('pro', 'Pro', 250, 15, 12999.00, '{"payroll": true}'),
  ('customize', 'Customize', NULL, NULL, NULL, '{"payroll": true, "custom": true}')
ON CONFLICT (code) DO NOTHING;
