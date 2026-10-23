# ADR-0004: Three database roles, none privileged

Status: accepted

| Role | Used by | Can |
|---|---|---|
| `humantech_owner` | migrations only | DDL; subject to RLS (not BYPASSRLS) |
| `humantech_app` | API at runtime | CRUD within tenant policies; append-only on ledgers/audit; no DDL |
| `humantech_system` | worker/provisioning | Execute queue + provisioning functions; sees only tables with explicit system policies |

None is SUPERUSER or BYPASSRLS (asserted by tests). Platform-only functions (`provision_tenant`, `claim_outbox_events`, ...) are revoked from the app role. Control flags such as `payroll_activated_at` and `payroll_maker_checker_required` cannot be updated by the runtime role at all.
