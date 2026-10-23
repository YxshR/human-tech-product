# ADR-0011: Identity via any OIDC provider; SQL-first data access

Status: accepted (product owner approved 2026-10-22)

## Identity
The API validates OIDC JWTs (signature via JWKS, issuer, audience, expiry; asymmetric algorithms only — `none` and HS* are rejected). It does not depend on Cognito: any provider (Cognito, Auth0, Keycloak, Entra, Google Workspace) works by configuring `OIDC_ISSUER`, `OIDC_AUDIENCE`, optional `OIDC_JWKS_URI`. Users are keyed by `sub` and created on first sign-in; authorisation (membership, roles, scope) lives only in our database. MFA is read from the `amr` claim; critical permissions require it.

## Data access
Prisma is not used: it cannot express exclusion constraints, triggers or RLS cleanly, and those are our core controls. Schema = ordered SQL migrations. Runtime queries are parameterised SQL through `pg`, always inside `withContext` (tenant-scoped transaction). A typed builder (Kysely with generated types) is the planned next step once the schema stabilises; adopting it is a repository-layer change that does not affect migrations or controls.

## EventBridge
Not used in v1; domain events are outbox rows (ADR-0002).
