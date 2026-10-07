-- Spatial facts (issue #64): the facts a profile asked for, as looked up for
-- the decision. JSON: { name: { missing: false, values, source } | { missing: true, reason } }.
-- NULL for profiles without facts.

ALTER TABLE decisions ADD COLUMN facts TEXT;
