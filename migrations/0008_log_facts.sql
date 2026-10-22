-- Facts that read the decision log (docs/modules.md): a client's decisions
-- of a profile since a time.
CREATE INDEX decisions_client_time ON decisions (client, profile_id, created_at);
