-- Decision chains (docs/decision-chains.md, #101).
--
-- requires: what the rules read from each required decision, when this one
-- was decided. JSON: { name: { decision, profile, profile_version, action,
-- outcome, reviewed, read } }. NULL for profiles without requires.
--
-- idempotency_key, request_digest: a repeated decide request with the same
-- key from the same client gets this decision again when its digest is the
-- same, and a 409 when it is not. NULL without a key.
--
-- replaces: the earlier decision of the same profile, ref and client that
-- this one replaced. NULL when there was none.
--
-- review_status may now also be 'superseded': a newer decision of the same
-- profile, ref and client replaced this one while its review was open, or
-- a decision made while a person resolved the one it would replace (it
-- never counts).

ALTER TABLE decisions ADD COLUMN requires TEXT;
ALTER TABLE decisions ADD COLUMN idempotency_key TEXT;
ALTER TABLE decisions ADD COLUMN request_digest TEXT;
ALTER TABLE decisions ADD COLUMN replaces TEXT;

CREATE UNIQUE INDEX decisions_idempotency ON decisions (client, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The earlier decisions of a chain step for one report: same profile, ref and client.
CREATE INDEX decisions_chain ON decisions (profile_id, ref, client, created_at);
