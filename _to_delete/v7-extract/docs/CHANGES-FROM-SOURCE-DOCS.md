# What changed versus the documents you provided

Everything below was either a reconciliation of contradictions in the source documents, an addition the blueprint needed, or an approved removal.

## Applied (reconciliations and fixes)
| Area | Source said | Now | Why |
|---|---|---|---|
| Roles | CSV 6 columns / blueprint 10 roles | 9 tenant roles + platform staff; payroll split into preparer and approver | Structural segregation of duties |
| API naming | `/leave/requests/{id}/approve` vs `/leave-requests/...`, finalise vs finalize | kebab-case plural, `finalize` | One convention (ADR-0009) |
| Payroll states | SQL 11 vs diagram | One state machine in the DB; payment status separate | ADR-0008 |
| Money | `numeric(14,2)` vs `numeric(19,4)` | 14,2 final / 12,6 rates / 19,4 trace | ADR-0005 |
| Migrations | one SQL file | 12 ordered, checksummed migrations (0001–0012); owner/app/system roles | ADR-0004 |
| Candidate stages | display text | snake_case codes + DB stage machine + auto history | Stable, testable |
| Controls | "the app should…" | Enforced by Postgres: locked payroll, append-only audit/ledger, maker-checker, exclusion constraints, leave overdraw guard | Cannot be bypassed by a bug |
| Added tables | — | branch scopes, invitations, holidays, shifts, leave policies, onboarding, files, clients/jobs, rule versions, payroll exceptions/adjustments, approvals, notifications, subscriptions/invoices, pay groups, support-access grants, import/export jobs, custom fields, saved views, privacy requests, retention policies | Needed by the blueprint's features |
| Aadhaar | — | Not stored | ADR-0006 |
| Payroll activation / statutory rules | (unspecified) | Operator CLI on the system role; rules need a second approver | ADR-0014 |
| Company creation | (unspecified) | `platform create-company` and `platform sync-roles` operator commands; no self sign-up | ADR-0014 |
| Login ↔ employee | (unspecified) | `PUT /employees/:id/login` links or unlinks a user to an employee (needs `user.manage`; 409 for archived/exited employees or logins already linked) | Without it nobody could reach self-service pages |
| Role matrix | HR could write identifiers but not see them; approvers could verify but not see them | `employee.read_identifiers` (masked values only) added to HR Admin and Payroll Approver | The screens were unusable otherwise |
| Employee list | Archived people appeared in lists | Hidden unless `status=archived` is asked for | Matches what the screen promises |
| Pay run | Zero paid days produced a silent zero payslip | `ZERO_PAID_DAYS` warning exception | Visible before approval |
| Web sessions | — | Company is chosen at first sign-in (`/auth/company`); a stale company cookie is replaced | A person with one company never sees a picker |
| Web build on Vercel | `Can't resolve '@humantech/contracts'` — workspace packages are consumed from `dist` and were not built | The web `build` script builds `@humantech/contracts` (and `authz`) first | Vercel builds only the web app |
| Web UI | Plain sidebar and forms | New design system: light/dark theme, icon sidebar (collapsible, mobile drawer), ⌘K / `/` command palette with live employee and candidate search (`/search`), toasts, confirm dialogs, button progress, loading skeleton, role-aware home screen | Easier to learn and faster to use |
| Sign-in page | `/` redirected straight to the identity provider; with no `OIDC_*`/`API_URL`/`APP_URL` set (e.g. a fresh Vercel deploy) the app threw errors and showed nothing | Public `/login` page (also the signed-out home); clear list of missing settings; provider/config failures return to `/login?error=` instead of crashing; redirects work without `APP_URL` | A deployment always shows something useful |
| Developer testing | No way to sign in without a real identity provider | `tools/dev/dev-idp.mjs` (local e-mail + password sign-in, 7 demo accounts) and `tools/dev/demo-seed.mjs` (demo company, branch, 3 employees); both refuse `NODE_ENV=production`; the `/login` page lists the accounts only in dev | Try every role locally |
| Public website | None: `/` went straight to the identity provider, so a visitor saw nothing | Public home (features, how it works, plans, FAQ), `/pricing`, `/signup` (plan request), `/login`; new `signup_requests` table (insert-only for the app role), public `POST /public/signup-requests` (validated, rate-limited, bot trap), operator commands `signup-requests` / `approve-signup`; plans Plus/Pro/Customize seeded | Plans and pay-first sign-up. **Prices and limits are placeholders**; plan features are not enforced yet; no payment gateway yet |
| Local run | Needed a separate login server and many manual steps | `pnpm dev` does everything; dev CSP allows `unsafe-eval` in development only | Easier developer testing |
| Bootstrap | Failed on a pre-created database | The database is re-owned by the owner role | Managed Postgres setups |
| Profile screen | — | `/me/permissions` also returns `employeeId` (null if the login has no employee record) | Lets the web app open "my profile" and send change requests |

## Removals / replacements — approved 2026-10-22 and applied
1. Redis/BullMQ and SQS+EventBridge dropped for v1; the Postgres outbox is the job queue (ADR-0002).
2. Prisma dropped; hand-written SQL migrations and parameterised `pg` (ADR-0011). **Kysely is not adopted yet** — a typed layer can be added later without touching migrations or controls.
3. EventBridge and Cognito dropped from the v1 diagram; the API validates any OIDC provider's JWTs (ADR-0011).

## New configuration (see `.env.example`)
`FIELD_ENCRYPTION_KEYS`, `BLIND_INDEX_KEY`, `FILE_SIGNING_SECRET`, `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `S3_*`, `MAX_UPLOAD_BYTES`, `SMTP_URL`, `MAIL_FROM`, `WEB_BASE_URL`, `SCHEDULER_INTERVAL_MS`, `WORKER_POLL_MS`, `OIDC_SCOPE` (web), `OPERATOR_EMAIL` (platform CLI). The previous `OBJECT_STORAGE_*` / `EMAIL_*` placeholders were never read by code and were removed.

## New packages and tooling
`@humantech/storage` (local + S3), `@humantech/jobs`, platform operator CLI in `@humantech/database`, a four-target Dockerfile (`api`, `worker`, `web`, `database`; uses `pnpm deploy --legacy`, which pnpm 10 requires).

## Known limits — read before go-live
- **No statutory values ship.** Provident fund, ESI, professional tax, TDS/labour-welfare rules must be loaded and approved per `docs/compliance/statutory-onboarding.md`; payroll is off until humanTech activates a company.
- Plan limits **and plan feature differences** are displayed but not enforced; there is no online payment gateway (payment is taken outside the app, then `approve-signup`).
- Subscription limits are displayed (Billing) but **not enforced**.
- Notifications reach the person who made a request (leave, profile change, bank, payslip); e-mail is sent only for invitations, when `SMTP_URL` is set. There are no approver-side reminders.
- Retention policies and privacy/erasure requests are **workflow only**: nothing is deleted or anonymised automatically.
- The approval-workflow tables exist but are unused; each module has its own maker-checker.
- Leave: `expiry_days` and per-period carry-forward are not enforced; the leave year is the calendar year; a half-day leave with no punch counts as absent.
- Attendance: one check-in session per day.
- Payroll: `per_unit`/`manual` pay components are unsupported; a salary change mid-period uses the assignment in effect at period end; bank details are not consumed by the payment export.
- Payslip PDFs are Latin-script only and show amounts with an `INR` prefix.
- No malware scanning of uploads (ADR-0013). Full identifier values (PAN etc.) can never be revealed again, only masked values.
- A "required" custom field cannot be cleared once set, but is not demanded when a record is created. Salary-assignment overrides are not exposed in the UI.
- The web app has automated tests for its form/redirect safety logic and a production build check; page rendering against a live identity provider has not been exercised in CI.
