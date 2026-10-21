# Database operations

- Bootstrap roles/database (superuser, once): `pnpm --filter @humantech/database bootstrap`
- Migrate (owner role, in CI/CD before deploy): `pnpm db:migrate`. Never edit an applied migration — the migrator refuses (checksum). Add a forward migration.
- Seed the permission catalogue after deploys that change `packages/authz`: `pnpm db:seed`; tenant system roles are re-synced by the API on tenant provision.
- Local Postgres without Docker: `scripts/pg-local.sh start`.
- Backups: point-in-time recovery on managed Postgres; restore drills quarterly; audit/ledger tables are append-only so restores never need merge logic.
