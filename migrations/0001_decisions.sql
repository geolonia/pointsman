-- Decision log and feedback. See docs/decision-log.md.

CREATE TABLE decisions (
  id              TEXT PRIMARY KEY,             -- UUID, returned as decision_id
  created_at      TEXT NOT NULL,                -- ISO 8601, UTC
  client          TEXT NOT NULL,                -- token client name (never the token)
  ref             TEXT,                         -- client reference, e.g. an issue id
  profile_id      TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  model           TEXT NOT NULL,                -- model that answered
  action          TEXT NOT NULL,
  rule            INTEGER,                      -- index of the matching policy rule; NULL = default
  answers         TEXT NOT NULL,                -- JSON: answers incl. probabilities
  state_hash      TEXT NOT NULL,                -- SHA-256 of the state sent to the model
  state           TEXT,                         -- JSON; only when the profile sets log.store_state
  callback_url    TEXT
);

CREATE INDEX decisions_profile ON decisions (profile_id, profile_version, created_at);
CREATE INDEX decisions_ref ON decisions (ref);

CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions (id),
  created_at  TEXT NOT NULL,
  client      TEXT NOT NULL,                    -- token client that sent the feedback
  by          TEXT NOT NULL,                    -- who corrected it, as given by the client
  correct     TEXT NOT NULL,                    -- JSON: { question: corrected value }
  note        TEXT
);

CREATE INDEX feedback_decision ON feedback (decision_id);
