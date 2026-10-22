-- Versions (#145): the engine version and the fact modules that answered the
-- decision's facts. JSON: { engine, modules: { name: version } }. NULL for
-- decisions made before fact modules.

ALTER TABLE decisions ADD COLUMN versions TEXT;
