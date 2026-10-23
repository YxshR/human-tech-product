# humanTech HRMS & Payroll

India-first, multi-tenant HRMS and payroll SaaS. Modular monolith, PostgreSQL 16, pnpm monorepo.

## Layout
| Path | What |
|---|---|
| `packages/database` | SQL migrations (source of truth for tenant isolation and payroll controls), migrator, role bootstrap, seeds, **real-Postgres tests** |
| `packages/authz` | Permission catalogue, 9 system roles, scope + field-level rules |
| `packages/contracts` | Zod request/response schemas, error codes, cursor pagination |
| `packages/jobs` | `JobQueue` port + Postgres-outbox adapter + `JobRunner` |
| `packages/storage` | File storage port with local-disk and S3 drivers |
| `apps/api` | NestJS API (~230 integration tests): auth, org, employees, profile, leave, attendance, compensation, payroll, recruitment, onboarding, imports, reports, audit, privacy, settings |
| `apps/worker` | Background worker: outbox job handlers (payslip PDFs, e-mail, leave accrual), scheduler, graceful shutdown |
| `apps/web` | Next.js 15 app: OIDC (PKCE) sign-in with refresh, permission-gated screens for every module above (ADR-0012) |
| `packages/payroll-engine` | Pure decimal payroll calculator with traces and golden tests (no statutory values shipped) |
| `docs/adr` | Architecture decisions · `docs/CHANGES-FROM-SOURCE-DOCS.md` lists every deviation |

## Quick start
```bash
pnpm install
docker compose up -d postgres          # or: scripts/pg-local.sh start
export TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```
Tests create and drop a throw-away database per run; nothing touches your data.

## Non-negotiables (all enforced by tests)
- Every tenant table: `tenant_id`, composite FKs, RLS enabled **and** forced.
- Runtime DB role is neither superuser nor BYPASSRLS and owns nothing.
- Locked payroll, audit logs and leave/ledger rows cannot be changed — even by the table owner.
- Preparer cannot approve payroll; maker cannot verify bank details.
- Money is never a float.

## Run locally (one command)
Needs Node 22, pnpm and Postgres 16 (`docker compose up -d postgres` is the easiest).
```bash
pnpm install
pnpm dev
```
`pnpm dev` creates `.env` (secret keys are generated), prepares the database, starts the API (:4000), worker and web app (:3000), with a **developer login built into the web app**, and creates a **Demo Company** with one account per role. Then open http://localhost:3000.

| Page | Address |
|---|---|
| Home (features, plans, FAQ) | `/` |
| Plans and pricing | `/pricing` |
| Get started (request a company on a plan) | `/signup` |
| Sign in | `/login` |
| App (after sign-in) | `/dashboard` |

Developer accounts (password `Demo@12345`, set `DEV_LOGIN_PASSWORD` to change it, `DEV_LOGIN=off` to disable): `owner@`, `hr@`, `finance@`, `approver@`, `recruiter@`, `manager@`, `employee@` + `demo.test`. On `/login` (development only) you get an e-mail + password form and one-click role buttons. The developer login is switched off (404) whenever `NODE_ENV=production`, and the demo-data script refuses to run there. (`tools/dev/dev-idp.mjs` is an older stand-alone login server; no longer needed.) Flags: `pnpm dev -- --rebuild`, `--no-demo`.

Manual route, with your own identity provider: `cp .env.example .env`, fill it in, then `pnpm --filter @humantech/database bootstrap`, `pnpm db:migrate && pnpm db:seed`, and start `@humantech/api`, `@humantech/worker` and `@humantech/web`. Sign-in needs an OIDC provider (Auth0, Keycloak, Entra, Cognito, Google…): create a public client with redirect URI `APP_URL/auth/callback` and set `OIDC_*`.
Local mail: `docker compose up -d mailpit`, then `SMTP_URL=smtp://localhost:1025` (UI on :8025).

## How a company joins
1. A visitor picks Plus, Pro or Customize on `/signup` (no login needed). The request is stored.
2. A humanTech operator sends the payment link, then, once paid: `signup-requests` (list) and `approve-signup <id> --slug <company-slug> --print-link` (creates the company, starts the subscription, invites the requester as company admin).
3. The requester signs in and accepts the invitation. **There is no online payment gateway yet**; payment is taken outside the app.

## Operating the platform (humanTech staff)
Payroll is switched on **per company by us**, and statutory rules are **data we load and a second person approves** — no statutory value ships in code. Commands use the system DB role (`DATABASE_SYSTEM_URL`) and are audited:
```bash
# Create a company; its first admin gets an invitation e-mail (add --print-link to see the link instead)
pnpm --filter @humantech/database platform create-company acme --name "Acme Pvt Ltd" --admin-email owner@acme.example --operator you@humantech.example
# After a deploy that changes roles/permissions: copy the new role definitions into existing companies
pnpm --filter @humantech/database platform sync-roles
pnpm --filter @humantech/database platform payroll-requests
pnpm --filter @humantech/database platform activate-payroll <company-slug> --operator you@humantech.example
pnpm --filter @humantech/database platform import-rules rules.json --operator preparer@humantech.example
pnpm --filter @humantech/database platform approve-rule <rule-id> --operator reviewer@humantech.example   # must be a different person
```
See `docs/runbooks/database-operations.md` and `docs/compliance/statutory-onboarding.md`.

## Images
`infra/docker/Dockerfile` builds `api`, `worker`, `web` and `database` (migrations + operator CLI) images; see the header of that file.
