# ADR-0002: Postgres transactional outbox as the v1 job queue

Status: accepted (product owner approved removing Redis/BullMQ and SQS/EventBridge from v1, 2026-10-22)

## Context
The source documents disagree: README/diagram say SQS + EventBridge, the blueprint says Redis + BullMQ. Jobs here (payslip PDFs, imports, exports, notifications, rule imports) must happen if and only if the business change that caused them commits.

## Decision
Use `outbox_events` as the queue. Producers insert in the same transaction as the business write. Workers call `app.claim_outbox_events()` (`FOR UPDATE SKIP LOCKED`, lease with expiry), then `complete_outbox_event` or `fail_outbox_event` (exponential backoff, dead-letter after `max_attempts` or on permanent failure). Idempotency key is unique per tenant. A thin `JobQueue` interface keeps SQS/BullMQ pluggable.

## Consequences
- One fewer moving part to secure, monitor and pay for; no dual-write problem.
- Throughput ceiling is far above HRMS needs (thousands of jobs/min). If it is ever hit, add an adapter; business code does not change.
- Tested: concurrent workers never claim the same row; completion is owner-bound and idempotent.

## Implementation
`packages/jobs`: `JobQueue` port, `PostgresJobQueue` (system role) and `PostgresJobProducer` (enqueue inside the business transaction), `JobRunner` (handler registry, concurrency, graceful stop, permanent-vs-transient errors, tenant-scoped `ctx.tx`). `apps/worker` wires it with two pools: app role for handler work, system role for claiming.
