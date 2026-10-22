# ADR-0014: Platform operations are a CLI, not a back-office app

Status: accepted

Creating a company, switching payroll on, and loading statutory rules are things a company must never self-serve. They are performed by humanTech staff with the **system** database role through `packages/database` commands (README → "Operating the platform"). Each action is audited with `source='system'` and the operator's e-mail. Rule sets enter as `in_review` and need approval by a **different** operator (enforced in the database). No statutory value is shipped in code; `docs/compliance/statutory-onboarding.md` lists what must be loaded and verified before a company's first real payroll.

A staff web console is a possible later addition; the CLI already covers the controls that matter.

`create-company` is the only way a tenant is created: the company's first admin receives an invitation (no self sign-up), so nobody can create a tenant by signing in. `sync-roles` pushes changed system-role definitions to existing companies. The first admin links their own employee record, and those of others, from the employee page (`PUT /employees/:id/login`, permission `user.manage`) — a login and an employee record are separate on purpose so that admins who are not employees need no record.
