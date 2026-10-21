# What changed versus the documents you provided

## Applied (reconciliations and fixes)
| Area | Source said | Now | Why |
|---|---|---|---|
| Roles | CSV 6 columns / blueprint 10 roles | 9 tenant roles + platform staff; payroll split into preparer and approver | Structural segregation of duties |
| API naming | `/leave/requests/{id}/approve` vs `/leave-requests/...`, finalise vs finalize | kebab-case plural, `finalize` | One convention (ADR-0009) |
| Payroll states | SQL 11 vs diagram | One state machine in the DB; payment status separate | ADR-0008 |
| Money | `numeric(14,2)` vs `numeric(19,4)` | 14,2 final / 12,6 rates / 19,4 trace | ADR-0005 |
| Migrations | one SQL file | 7 ordered, checksummed migrations; owner/app/system roles | ADR-0004 |
| Candidate stages | display text | snake_case codes + DB stage machine + auto history | Stable, testable |
| Controls | "the app should…" | Enforced by Postgres: locked payroll, append-only audit/ledger, maker-checker, exclusion constraints, leave overdraw guard | Cannot be bypassed by a bug |
| Added tables | — | branch scopes, invitations, holidays, shifts, leave policies, onboarding, files, clients/jobs, rule versions, payroll exceptions/adjustments, approvals, notifications, subscriptions/invoices, pay groups, support-access grants | Needed by the blueprint's features |
| Aadhaar | — | Not stored | ADR-0006 |

## Removals — approved 2026-10-22 and applied
1. Drop Redis/BullMQ and SQS+EventBridge for v1; use the Postgres outbox (ADR-0002).
2. Drop Prisma; hand-written SQL migrations + Kysely.
3. Drop EventBridge and Cognito from the v1 diagram; validate any OIDC provider's JWTs.

Note on #2: runtime SQL is parameterised `pg` for now; Kysely with generated types is the planned next step (ADR-0011).
