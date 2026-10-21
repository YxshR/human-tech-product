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

## Run locally
```bash
cp .env.example .env   # every variable is explained inside; generate the keys as the comments say
export $(grep -v '^#' .env | xargs)
pnpm --filter @humantech/database bootstrap   # once: creates the three DB roles (needs DATABASE_ADMIN_URL etc., see .env.example)
pnpm db:migrate && pnpm db:seed
pnpm --filter @humantech/api dev        # :4000
pnpm --filter @humantech/worker dev
pnpm --filter @humantech/web dev        # :3000
```
Sign-in needs an OIDC provider (Auth0, Keycloak, Entra, Cognito, Google…): create a public client with redirect URI `APP_URL/auth/callback` and set `OIDC_*`.
Local mail: `docker compose up -d mailpit`, then `SMTP_URL=smtp://localhost:1025` (UI on :8025).

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
