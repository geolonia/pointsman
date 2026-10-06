-- Published profile versions: the write-once record behind
-- scripts/publish-profiles.mjs. D1 is strongly consistent, unlike KV, so a
-- published id + version can never get different content, even when deploys
-- run shortly after each other.

CREATE TABLE profile_versions (
  profile_id   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  content_hash TEXT NOT NULL,   -- SHA-256 of the profile (canonical JSON)
  published_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, version)
);
