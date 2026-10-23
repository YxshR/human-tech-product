# ADR-0001: Modular monolith in a pnpm monorepo

Status: accepted

## Context
The product is a multi-tenant HRMS/payroll SaaS built by a small team. Payroll correctness and tenant safety matter far more than independent scaling of services.

## Decision
One deployable API (NestJS), one worker process (same codebase, different entrypoint), one web app (Next.js), plus shared packages in a single pnpm workspace: `authz`, `contracts`, `database`, `payroll-engine`, `config`. Domain modules inside the API talk through typed interfaces, not network calls.

## Consequences
- Transactions can span modules (payroll lock + audit + outbox event commit atomically).
- Packages with no framework dependency (`payroll-engine`, `authz`, `contracts`) are unit-testable in milliseconds.
- Extracting a service later is possible because module boundaries are already explicit.
