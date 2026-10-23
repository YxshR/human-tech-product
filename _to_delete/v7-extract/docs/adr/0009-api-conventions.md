# ADR-0009: API conventions

- Kebab-case plural resources: `/leave-requests/{id}/approve`, `/payroll-runs/{id}/finalize` (American spelling in code and URLs).
- The client *selects* a company with `X-Tenant-Id`; the server never trusts it: it verifies an active membership for the authenticated user and then derives roles, permissions and branch scope. A non-member gets the same 404 as a company that does not exist.
- Success: `{ "data": ... }`; lists add `{ "page": { "nextCursor", "limit" } }` (cursor pagination only).
- Errors: `{ "error": { "code", "message", "requestId", "fields?" } }` with stable codes. DB-raised SQLSTATEs map to codes in one table (`SQLSTATE_TO_ERROR`) covered by a parity test.
- Out-of-tenant or out-of-scope records return 404, missing permission 403 (no existence oracle).
- Mutations that create or move money or documents accept `Idempotency-Key`. Updates use optimistic `version`.
- Request bodies are `.strict()` Zod schemas: unknown keys (e.g. `tenantId`, `payrollEligible`) are rejected, preventing mass assignment.
