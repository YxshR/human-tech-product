# humanTech HRMS & Payroll

India-first, multi-tenant HRMS and payroll SaaS. Modular monolith, PostgreSQL 16, pnpm monorepo.

## Layout
| Path | What |
|---|---|
| `packages/database` | SQL migrations (source of truth for tenant isolation and payroll controls), migrator, role bootstrap, seeds, **real-Postgres tests** |
| `packages/authz` | Permission catalogue, 9 system roles, scope + field-level rules |
| `packages/contracts` | Zod request/response schemas, error codes, cursor pagination |
| `packages/jobs` | `JobQueue` port + Postgres-outbox adapter + `JobRunner` |
| `apps/api` | NestJS API: OIDC JWT auth, tenant-scoped transactions, permission/MFA guard, employees slice |
| `apps/worker` | Background worker (job handlers, graceful shutdown) |
| `apps/web` | Next.js app: OIDC (PKCE) sign-in, company switcher, employee screens |
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
cp .env.example .env   # fill OIDC_* ; DATABASE_* for the three roles
pnpm db:migrate && pnpm db:seed
pnpm --filter @humantech/api dev        # :4000
pnpm --filter @humantech/worker dev
pnpm --filter @humantech/web dev        # :3000 (needs APP_URL, API_URL, OIDC_ISSUER, OIDC_CLIENT_ID)
```
