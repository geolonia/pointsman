-- Retention (src/retention.ts, DECISION_LOG_DAYS): the cron's purge selects
-- the oldest decisions by created_at. Without this index every run scans the
-- whole table, also when there is nothing to delete.
CREATE INDEX decisions_created ON decisions (created_at);
