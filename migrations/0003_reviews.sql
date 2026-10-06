-- Review queue and callbacks (issue #9). Decisions with action "review" wait
-- for a person; when resolved, the final answer is sent to callback_url.

ALTER TABLE decisions ADD COLUMN review_status TEXT;        -- 'pending' | 'resolved' | NULL (no review)
ALTER TABLE decisions ADD COLUMN resolved_at TEXT;
ALTER TABLE decisions ADD COLUMN resolved_by TEXT;
ALTER TABLE decisions ADD COLUMN resolved_client TEXT;      -- token client that resolved it
ALTER TABLE decisions ADD COLUMN final_action TEXT;
ALTER TABLE decisions ADD COLUMN final_answers TEXT;        -- JSON: { question: { value, source } }

ALTER TABLE decisions ADD COLUMN callback_status TEXT;      -- 'pending' | 'delivered' | 'failed' | NULL (no callback)
ALTER TABLE decisions ADD COLUMN callback_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN callback_last_error TEXT;
ALTER TABLE decisions ADD COLUMN callback_next_at TEXT;     -- when the next retry is due

CREATE INDEX decisions_review ON decisions (review_status, profile_id, created_at);
CREATE INDEX decisions_callback ON decisions (callback_status, callback_next_at);
