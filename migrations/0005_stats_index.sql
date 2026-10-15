-- GET /v1/stats/{profile}: a range scan over one profile's recent decisions,
-- instead of every decision the profile ever had (decisions_profile has
-- profile_version between profile_id and created_at).
CREATE INDEX decisions_profile_time ON decisions (profile_id, created_at, action);
