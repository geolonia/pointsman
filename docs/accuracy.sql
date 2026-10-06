-- Accuracy per profile version. See docs/decision-log.md.
-- Run: wrangler d1 execute DB --remote --file docs/accuracy.sql
-- (test/worker/accuracy.test.ts runs this file against known data.)

-- Feedback rate and override rate per version. A feedback that changes at
-- least one answer counts as an override.
SELECT d.profile_id, d.profile_version,
       COUNT(DISTINCT d.id)          AS decisions,
       COUNT(DISTINCT f.decision_id) AS with_feedback,
       COUNT(DISTINCT CASE WHEN EXISTS (
         SELECT 1 FROM json_each(f.correct) c
         WHERE c.value IS NOT json_extract(d.answers, '$."' || c.key || '".value')
       ) THEN f.decision_id END)     AS overridden
FROM decisions d
LEFT JOIN feedback f ON f.decision_id = d.id
GROUP BY d.profile_id, d.profile_version
ORDER BY d.profile_id, d.profile_version;
