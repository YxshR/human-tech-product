/**
 * The three public plans: Free for small teams, Pro (paid) and Customize (tailored). PRICES AND LIMITS BELOW ARE
 * PLACEHOLDERS to confirm before launch; keep them in step with the `plans` rows in migrations 0013 and 0014.
 * No payment is collected in the app yet: Pro and Customize start as a 14-day trial.
 */
export type PlanCode = 'free' | 'pro' | 'customize';
export interface Plan {
  code: PlanCode; name: string; tagline: string; price: string | null; per: string; people: string; branches: string; highlight?: boolean; cta: string; features: string[];
}
export const PLANS: Plan[] = [
  { code: 'free', name: 'Free', tagline: 'For very small teams getting started with people operations.', price: '₹0', per: 'forever', people: 'Up to 10 employees', branches: '1 branch', cta: 'Start free',
    features: ['Employee records, documents and onboarding', 'Attendance, leave and holidays', 'Self-service: profile and requests', 'Roles and permissions', 'Reports and CSV exports'] },
  { code: 'pro', name: 'Pro', tagline: 'Payroll, hiring and controls for larger, multi-branch companies.', price: '₹12,999', per: 'per month', people: 'Up to 250 employees', branches: 'Up to 15 branches', highlight: true, cta: 'Start with Pro',
    features: ['Everything in Free', 'Payroll with maker-checker approval and payslips', 'Statutory rules set up and approved with our team', 'Recruitment pipeline and client tracking', 'Bulk imports, custom fields, audit log', 'Priority support'] },
  { code: 'customize', name: 'Customize', tagline: 'Your size, your rules: tailored set-up and a plan built around you.', price: null, per: 'tailored quote', people: 'Any number of employees', branches: 'Any number of branches', cta: 'Start with Customize',
    features: ['Everything in Pro', 'Custom workflows and integrations', 'Single sign-on with your identity provider', 'Dedicated onboarding and data migration', 'Agreed service levels', 'A named contact at humanTech'] },
];
export const planByCode = (c: string | undefined): Plan | undefined => PLANS.find((p) => p.code === c);
