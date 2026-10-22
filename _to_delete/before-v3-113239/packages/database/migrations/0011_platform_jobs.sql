-- 0011_platform_jobs.sql
-- Worker needs: (a) to remove one-time secrets from a job's payload once they have been used,
-- (b) a scheduler (system role) that enqueues recurring per-tenant jobs.

-- The dispatcher is the only role that may touch outbox rows, so scrubbing lives here. Only the
-- worker that currently holds the claim can scrub, and only the named payload keys are removed.
CREATE FUNCTION app.scrub_outbox_payload(p_id uuid, p_worker text, p_keys text[]) RETURNS boolean LANGUAGE sql AS $$
  WITH u AS (
    UPDATE outbox_events SET payload = payload - p_keys
     WHERE id = p_id AND claimed_by = p_worker AND processed_at IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
REVOKE ALL ON FUNCTION app.scrub_outbox_payload(uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scrub_outbox_payload(uuid, text, text[]) TO humantech_system;

-- The scheduler inserts jobs for every active tenant (idempotency keys make re-runs harmless).
GRANT INSERT ON outbox_events TO humantech_system;
