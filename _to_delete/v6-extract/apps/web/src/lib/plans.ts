/**
 * The three public plans. PRICES AND LIMITS BELOW ARE PLACEHOLDERS to confirm before launch; keep them in step with the
 * `plans` rows in migration 0013 (which hold the limits the billing screen shows).
 */
export type PlanCode = 'plus' | 'pro' | 'customize';
export interface Plan {
  code: PlanCode; name: string; tagline: string; price: string | null; per: string; people: string; branches: string; highlight?: boolean; cta: string; features: string[];
}
export const PLANS: Plan[] = [
  { code: 'plus', name: 'Plus', tagline: 'Everything a growing team needs to run people operations.', price: '₹4,999', per: 'per month', people: 'Up to 50 employees', branches: 'Up to 3 branches', cta: 'Start with Plus',
    features: ['Employee records, documents and onboarding', 'Attendance, leave and holidays', 'Self-service: profile, payslips, requests', 'Roles and permissions per branch', 'Reports and CSV exports', 'E-mail support'] },
  { code: 'pro', name: 'Pro', tagline: 'Payroll, hiring and controls for larger, multi-branch companies.', price: '₹12,999', per: 'per month', people: 'Up to 250 employees', branches: 'Up to 15 branches', highlight: true, cta: 'Start with Pro',
    features: ['Everything in Plus', 'Payroll with maker-checker approval and payslips', 'Statutory rules set up and approved with our team', 'Recruitment pipeline and client tracking', 'Bulk imports, custom fields, audit log', 'Priority support'] },
  { code: 'customize', name: 'Customize', tagline: 'Your size, your rules: tailored set-up and a plan built around you.', price: null, per: 'tailored quote', people: 'Any number of employees', branches: 'Any number of branches', cta: 'Talk to us',
    features: ['Everything in Pro', 'Custom workflows and integrations', 'Single sign-on with your identity provider', 'Dedicated onboarding and data migration', 'Agreed service levels', 'A named contact at humanTech'] },
];
export const planByCode = (c: string | undefined): Plan | undefined => PLANS.find((p) => p.code === c);
