# ADR-0003: Tenant isolation = tenant_id + composite foreign keys + forced RLS

Status: accepted

## Decision
1. Every tenant-owned table has `tenant_id uuid NOT NULL`.
2. Every foreign key between tenant tables is composite `(tenant_id, id)`, so a row can never reference another tenant's row, even with a buggy query.
3. Row Level Security is `ENABLE`d **and** `FORCE`d with one `tenant_isolation` policy (USING + WITH CHECK) on `app.current_tenant_id()`.
4. The tenant is set per request with `set_config('app.tenant_id', $1, true)` inside the request's transaction (transaction-local), after the membership has been verified server-side. A missing context yields zero rows, not an error and not everything.

## Enforced by tests
Schema lint fails the build if a `tenant_id` table lacks RLS/force/policy, if a table without `tenant_id` is not on the allow-list, or if a tenant-to-tenant FK is non-composite. Negative tests cover cross-tenant read/update/delete/insert/move, pooled-connection leakage and non-UUID injection attempts.
