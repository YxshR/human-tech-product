# Database operations

- Bootstrap roles/database (superuser, once): `pnpm --filter @humantech/database bootstrap`
- Migrate (owner role, in CI/CD before deploy): `pnpm db:migrate`. Never edit an applied migration — the migrator refuses (checksum). Add a forward migration.
- Seed the permission catalogue after deploys that change `packages/authz`: `pnpm db:seed`, then re-sync every company's system roles with `platform sync-roles` (owner role). Roles are copied into each company when it is created; they are **not** updated automatically.
- Local Postgres without Docker: `scripts/pg-local.sh start`.
- Backups: point-in-time recovery on managed Postgres; restore drills quarterly; audit/ledger tables are append-only so restores never need merge logic.

## Platform operator commands (system role)
Run with `DATABASE_SYSTEM_URL` set (the `humantech_system` role). Every command writes an audit row with `source='system'` naming the operator (`--operator <email>` or `OPERATOR_EMAIL`).

| Command | Purpose |
|---|---|
| `platform create-company <slug> --name "Legal name" --admin-email <e-mail> [--display "Name"] [--operator <e-mail>] [--print-link]` | Create a company (owner + system roles): company record, its system roles, a 7-day invitation for the first company admin and the invitation e-mail job. `--print-link` prints the accept link when no mail is configured |
| `platform sync-roles [slug]` | Re-copy the current system-role definitions into one company or all of them (owner role). Run after every deploy that changes `packages/authz` |
| `platform payroll-requests` | Companies that asked for payroll to be switched on |
| `platform activate-payroll <slug> --operator <email> [--force]` | Switch payroll on (tenant must be `trial` or `active`; `--force` allows activation without a request) |
| `platform import-rules <file.json> --operator <email>` | Load statutory rule versions as `in_review` (validated before insert) |
| `platform list-rules [--status in_review\|approved\|...]` | Review what is loaded |
| `platform approve-rule <id> --operator <reviewer> [--notes "..."]` | Approve a rule. The reviewer **cannot** be the person who imported it |

In a container: `docker run --env-file .env humantech-database node dist/cli.js <command> ...`.

## Background jobs
The worker claims jobs from the `outbox_events` table (system role), runs handlers under the app role, and retries with back-off; handlers are idempotent. A job that exhausts its attempts is dead-lettered (`dead_lettered_at` set) with its error; inspect as the owner role: `SELECT id, event_type, attempts, last_error_code, last_error_message FROM outbox_events WHERE dead_lettered_at IS NOT NULL`. Sensitive payload keys are scrubbed after success.

## Files
Uploads pass through the API (size/type/hash checked), live in the configured storage driver, and are served only through 60-second signed links; every access is written to `file_access_events`. There is no malware scanner yet — put one in front of the bucket before accepting uploads from untrusted users.

## Deploying the web app on Vercel

- Project root: `apps/web`. Turn on "Include source files outside of the Root Directory" (the app uses the workspace packages).
- Install: `pnpm install --frozen-lockfile` (run from the repo root). Build: the default `pnpm run build` — it builds `@humantech/contracts` and `@humantech/authz` first.
- Environment variables (Production and Preview): `API_URL` (public URL of the API), `APP_URL` (public URL of this web app), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and, if your provider needs them, `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE`, `OIDC_SCOPE`, `OIDC_USE_ID_TOKEN`.
- The API and worker are not run on Vercel; host them with the Docker images and point `API_URL` at the API.
