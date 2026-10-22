# ADR-0007: One permission catalogue, nine tenant roles

Status: accepted

The starter CSV had 6 role columns; the blueprint listed 10 roles. Resolution: **nine tenant roles** plus **platform staff** (a separate table, never tenant users).

Company Admin, HR Admin, Recruiter, Finance/Payroll (preparer), Payroll Approver (checker), Store Manager, Department Manager, Employee, Auditor.

The blueprint's single "Finance/Payroll" role is split so segregation of duties is structural: no role can both calculate and approve payroll, assign and approve salary, or enter and verify bank details (asserted by tests). Company Admin has **no** payroll/salary/bank permissions by default. Source of truth is `packages/authz/src/permissions.ts`; the database `permissions` table is seeded from it and a test asserts equality.
