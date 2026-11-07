-- Manual alternative: run once against a backup while the app is stopped,
-- before starting the upgraded app. The upgraded app performs this migration
-- automatically; do not run this file after that startup migration has run.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE users
SET name = COALESCE(json_extract(data_json, '$.Name'), '')
WHERE name = '';
CREATE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS asset_field_options (
    field_name TEXT NOT NULL,
    value TEXT NOT NULL,
    is_legacy INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy IN (0, 1)),
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (field_name, value)
);

INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position) VALUES
 ('Replacement Status', 'Not replaced', 0, 0),
 ('Replacement Status', 'Replaced', 0, 1),
 ('Replacement Status', 'Pending replacement', 0, 2),
 ('Replacement Status', 'In progress', 0, 3),
 ('Staff Member Lifecycle Status', 'Active', 0, 0),
 ('Staff Member Lifecycle Status', 'Leaver', 0, 1),
 ('Staff Member Lifecycle Status', 'Contractor', 0, 2),
 ('Staff Member Lifecycle Status', 'Unknown', 0, 3);

-- Preserve out-of-enum values already in inventory and expose them as legacy choices.
INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position)
SELECT 'Replacement Status', json_extract(data_json, '$."Replacement Status"'), 1, 1000
FROM inventory_devices
WHERE trim(COALESCE(json_extract(data_json, '$."Replacement Status"'), '')) <> ''
  AND json_extract(data_json, '$."Replacement Status"') NOT IN (
      'Not replaced', 'Replaced', 'Pending replacement', 'In progress'
  );
INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position)
SELECT 'Staff Member Lifecycle Status', json_extract(data_json, '$."Staff Member Lifecycle Status"'), 1, 1000
FROM inventory_devices
WHERE trim(COALESCE(json_extract(data_json, '$."Staff Member Lifecycle Status"'), '')) <> ''
  AND json_extract(data_json, '$."Staff Member Lifecycle Status"') NOT IN (
      'Active', 'Leaver', 'Contractor', 'Unknown'
  );

-- Handover Eligibility is JSON in the current app schema, not a physical SQL column.
UPDATE replacement_history
SET data_json = json_remove(data_json, '$."Handover Eligibility"')
WHERE json_type(data_json, '$."Handover Eligibility"') IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS inventory_enum_insert
BEFORE INSERT ON inventory_devices
BEGIN
  SELECT CASE WHEN trim(COALESCE(json_extract(NEW.data_json, '$."Replacement Status"'), '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM asset_field_options WHERE field_name='Replacement Status' AND value=json_extract(NEW.data_json, '$."Replacement Status"'))
    THEN RAISE(ABORT, 'Invalid Replacement Status enum value') END;
  SELECT CASE WHEN trim(COALESCE(json_extract(NEW.data_json, '$."Staff Member Lifecycle Status"'), '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM asset_field_options WHERE field_name='Staff Member Lifecycle Status' AND value=json_extract(NEW.data_json, '$."Staff Member Lifecycle Status"'))
    THEN RAISE(ABORT, 'Invalid Staff Member Lifecycle Status enum value') END;
END;

CREATE TRIGGER IF NOT EXISTS inventory_enum_update
BEFORE UPDATE OF data_json ON inventory_devices
BEGIN
  SELECT CASE WHEN trim(COALESCE(json_extract(NEW.data_json, '$."Replacement Status"'), '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM asset_field_options WHERE field_name='Replacement Status' AND value=json_extract(NEW.data_json, '$."Replacement Status"'))
    THEN RAISE(ABORT, 'Invalid Replacement Status enum value') END;
  SELECT CASE WHEN trim(COALESCE(json_extract(NEW.data_json, '$."Staff Member Lifecycle Status"'), '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM asset_field_options WHERE field_name='Staff Member Lifecycle Status' AND value=json_extract(NEW.data_json, '$."Staff Member Lifecycle Status"'))
    THEN RAISE(ABORT, 'Invalid Staff Member Lifecycle Status enum value') END;
END;

COMMIT;
