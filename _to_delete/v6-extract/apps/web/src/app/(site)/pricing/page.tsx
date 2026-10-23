import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Faq, PlanCards, Section } from '@/components/site';

export const metadata = { title: 'Plans & pricing' };

const ROWS: Array<[string, string, string, string]> = [
  ['Employees', 'Up to 50', 'Up to 250', 'Any number'],
  ['Branches', 'Up to 3', 'Up to 15', 'Any number'],
  ['Employee records, documents, onboarding', '✓', '✓', '✓'],
  ['Attendance, leave and holidays', '✓', '✓', '✓'],
  ['Self-service profile and payslips', '✓', '✓', '✓'],
  ['Roles and branch-level access', '✓', '✓', '✓'],
  ['Payroll runs with approval and PDF payslips', '—', '✓', '✓'],
  ['Recruitment and client tracking', '—', '✓', '✓'],
  ['Bulk imports, custom fields, audit log', '—', '✓', '✓'],
  ['Single sign-on and custom integrations', '—', '—', '✓'],
  ['Data migration and dedicated onboarding', '—', '—', '✓'],
  ['Support', 'E-mail', 'Priority', 'Named contact + agreed service levels'],
];

export default function Pricing() {
  return (
    <>
      <section className="site-hero compact"><div className="site-wrap" style={{ textAlign: 'center' }}>
        <h1>Plans that grow with you</h1><p className="lead" style={{ margin: '12px auto 0' }}>Prices in INR, billed monthly. Pay first, then we set up your company and invite you.</p>
      </div></section>
      <Section><PlanCards /></Section>
      <Section title="Compare plans" tone="alt">
        <div className="scroll"><table className="cmp"><thead><tr><th>Feature</th><th>Plus</th><th>Pro</th><th>Customize</th></tr></thead>
          <tbody>{ROWS.map(([f, a, b, c]) => <tr key={f}><td>{f}</td>{[a, b, c].map((v, i) => <td key={i}>{v === '✓' ? <Icon name="check" size={18} /> : v}</td>)}</tr>)}</tbody></table></div>
      </Section>
      <Section title="Questions"><Faq /><p style={{ textAlign: 'center', marginTop: 24 }}><Link className="btn primary lg" href="/signup">Get started</Link></p></Section>
    </>
  );
}
