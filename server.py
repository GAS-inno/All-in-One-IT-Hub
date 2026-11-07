"""Local HTTP server and SQLite API for the NexIT asset inventory."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import traceback
from contextlib import closing, contextmanager
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from dashboard_metrics import build_dashboard, filter_options, matching_record_indexes

ROOT = Path(__file__).resolve().parent
if os.name == "nt":
    DATA_ROOT = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
elif sys.platform == "darwin":
    DATA_ROOT = Path.home() / "Library" / "Application Support"
else:
    DATA_ROOT = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
DATA_DIR = DATA_ROOT / "NexIT-Asset-Inventory"
DATABASE_PATH = DATA_DIR / "nexit-assets.db"
MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_DATABASE_BACKUP_BYTES = 512 * 1024 * 1024
API_VERSION = "2026-11-07-autocomplete-v1"
MISSING_IDENTIFIERS = {"n/a", "na", "none", "null", "unknown", "-"}
_DB_LOCK = threading.RLock()
ASSET_FIELD_ENUMS = {
    "Replacement Status": ("Not replaced", "Replaced", "Pending replacement", "In progress"),
    "Staff Member Lifecycle Status": ("Active", "Leaver", "Contractor", "Unknown"),
}
ELIGIBLE_HANDOUT_STATUS_NAMES = {
    "ready to deploy", "deployable", "available", "available for handover", "ready for handover",
}


def connect_database(path: Path | None = None) -> sqlite3.Connection:
    path = path or DATABASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS inventory_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position INTEGER NOT NULL,
            device_type TEXT NOT NULL DEFAULT 'laptop',
            device_id TEXT NOT NULL DEFAULT '',
            device_name TEXT NOT NULL DEFAULT '',
            serial_number TEXT NOT NULL DEFAULT '',
            normalized_serial TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL DEFAULT '',
            group_tag TEXT NOT NULL DEFAULT '',
            manufacturer TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            compliance TEXT NOT NULL DEFAULT '',
            warranty_start_date TEXT NOT NULL DEFAULT '',
            warranty_end_date TEXT NOT NULL DEFAULT '',
            duplicate_serial INTEGER NOT NULL DEFAULT 0,
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_inventory_serial
            ON inventory_devices(normalized_serial);
        CREATE INDEX IF NOT EXISTS idx_inventory_group
            ON inventory_devices(group_name, group_tag);
        CREATE TABLE IF NOT EXISTS warranty_records (
            normalized_serial TEXT PRIMARY KEY,
            serial_number TEXT NOT NULL,
            warranty_start_date TEXT NOT NULL DEFAULT '',
            warranty_end_date TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS replacement_history (
            replacement_id TEXT PRIMARY KEY COLLATE NOCASE,
            position INTEGER NOT NULL,
            old_serial TEXT NOT NULL DEFAULT '',
            new_serial TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_replacement_old_serial
            ON replacement_history(old_serial COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS checkout_history (
            event_id TEXT PRIMARY KEY COLLATE NOCASE,
            position INTEGER NOT NULL,
            asset_key TEXT NOT NULL,
            event_date TEXT NOT NULL,
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_checkout_asset
            ON checkout_history(asset_key, position);
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY COLLATE NOCASE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            normalized_email TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_email
            ON users(normalized_email);
        CREATE TABLE IF NOT EXISTS asset_status_labels (
            label_id TEXT PRIMARY KEY COLLATE NOCASE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            label_type TEXT NOT NULL,
            data_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
    if "name" not in user_columns:
        connection.execute("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''")
    connection.execute("UPDATE users SET name=COALESCE(json_extract(data_json, '$.Name'), '') WHERE name='' ")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_users_email_value ON users(email COLLATE NOCASE)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inventory_device_name ON inventory_devices(device_name COLLATE NOCASE)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inventory_serial_number ON inventory_devices(serial_number COLLATE NOCASE)")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS asset_field_options (
            field_name TEXT NOT NULL,
            value TEXT NOT NULL,
            is_legacy INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy IN (0, 1)),
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (field_name, value)
        )
    """)
    for field_name, values in ASSET_FIELD_ENUMS.items():
        for position, value in enumerate(values):
            connection.execute(
                "INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position) VALUES (?, ?, 0, ?)",
                (field_name, value, position),
            )
        connection.execute(
            """INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position)
               SELECT ?, json_extract(data_json, ?), 1, 1000
               FROM inventory_devices
               WHERE trim(COALESCE(json_extract(data_json, ?), '')) <> ''
                 AND NOT EXISTS (
                   SELECT 1 FROM asset_field_options AS option
                   WHERE option.field_name=? AND option.value=json_extract(inventory_devices.data_json, ?)
                 )""",
            (field_name, f'$."{field_name}"', f'$."{field_name}"', field_name, f'$."{field_name}"'),
        )
    connection.executescript("""
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
        CREATE TRIGGER IF NOT EXISTS replacement_handover_eligibility_insert
        BEFORE INSERT ON replacement_history
        BEGIN
          SELECT CASE WHEN json_type(NEW.data_json, '$."Handover Eligibility"') IS NOT NULL
            THEN RAISE(ABORT, 'Handover Eligibility is deprecated; remove the field') END;
        END;
        CREATE TRIGGER IF NOT EXISTS replacement_handover_eligibility_update
        BEFORE UPDATE OF data_json ON replacement_history
        BEGIN
          SELECT CASE WHEN json_type(NEW.data_json, '$."Handover Eligibility"') IS NOT NULL
            THEN RAISE(ABORT, 'Handover Eligibility is deprecated; remove the field') END;
        END;
    """)
    connection.execute("UPDATE replacement_history SET data_json=json_remove(data_json, '$.\"Handover Eligibility\"') WHERE json_type(data_json, '$.\"Handover Eligibility\"') IS NOT NULL")
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(inventory_devices)")}
    if "device_type" not in columns:
        connection.execute("ALTER TABLE inventory_devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'laptop'")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inventory_device_type ON inventory_devices(device_type)")
    return connection


@contextmanager
def database_connection():
    connection = connect_database()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _create_database_backup() -> Path:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    descriptor, backup_name = tempfile.mkstemp(prefix="nexit-backup-", suffix=".db", dir=DATABASE_PATH.parent)
    os.close(descriptor)
    backup_path = Path(backup_name)
    try:
        with database_connection() as source, closing(sqlite3.connect(backup_path)) as destination:
            source.backup(destination)
        return backup_path
    except (OSError, sqlite3.Error):
        backup_path.unlink(missing_ok=True)
        raise


def _validate_database_backup(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("The selected backup file is empty or missing.")
    database_uri = f"file:{quote(str(path.resolve()))}?mode=ro"
    try:
        with closing(sqlite3.connect(database_uri, uri=True)) as connection:
            integrity = connection.execute("PRAGMA quick_check").fetchone()
            if integrity is None or integrity[0] != "ok":
                raise ValueError("The selected backup failed SQLite integrity validation.")
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            required_columns = {
                "inventory_devices": {"data_json"},
                "warranty_records": {"data_json"},
                "replacement_history": {"data_json"},
                "app_metadata": {"key", "value"},
            }
            for table, expected_columns in required_columns.items():
                columns = {
                    row[1] for row in connection.execute(f"PRAGMA table_info({table})")
                }
                if not expected_columns.issubset(columns):
                    raise ValueError("The selected SQLite file is not a NexIT database backup.")
            if "checkout_history" in tables:
                checkout_columns = {
                    row[1] for row in connection.execute("PRAGMA table_info(checkout_history)")
                }
                if "data_json" not in checkout_columns:
                    raise ValueError("The selected SQLite file has an invalid checkout history table.")
            json_tables = ["inventory_devices", "warranty_records", "replacement_history"]
            if "checkout_history" in tables:
                json_tables.append("checkout_history")
            if "users" in tables:
                json_tables.append("users")
            for table in json_tables:
                for (data_json,) in connection.execute(f"SELECT data_json FROM {table}"):
                    try:
                        record = json.loads(data_json)
                    except (json.JSONDecodeError, TypeError) as error:
                        raise ValueError("The selected NexIT database contains invalid record data.") from error
                    if not isinstance(record, dict):
                        raise ValueError("The selected NexIT database contains invalid record data.")
    except sqlite3.Error as error:
        raise ValueError("The selected file is not a readable SQLite database.") from error
    required_tables = {"inventory_devices", "warranty_records", "replacement_history", "app_metadata"}
    missing_tables = required_tables - tables
    if missing_tables:
        raise ValueError("The selected SQLite file is not a NexIT database backup.")


def _restore_database_backup(path: Path) -> None:
    _validate_database_backup(path)
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    os.replace(path, DATABASE_PATH)


def _serial_key(serial: Any) -> str:
    value = str(serial or "").strip().upper()
    while True:
        base, marker, suffix = value.rpartition("--")
        if marker and suffix.isdigit():
            value = base
        else:
            break
    return "".join(value.split())


def _like_pattern(query: str) -> str:
    escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _asset_serial(record: dict[str, Any]) -> str:
    for key in ("Serial number", "IntuneGroup.SerialNumber"):
        serial = _serial_key(record.get(key))
        if serial and serial.casefold() not in MISSING_IDENTIFIERS:
            return serial
    return ""


def _as_text(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "":
            return str(value)
    return ""


def _replace_inventory(connection: sqlite3.Connection, devices: list[dict[str, Any]]) -> None:
    assignments: dict[str, list[tuple[str, str]]] = {}
    for record in devices:
        serial = _asset_serial(record)
        name = " ".join(_as_text(record, "Primary user display name").casefold().split())
        email = _as_text(record, "Primary user email address", "Primary user UPN").strip().casefold()
        if not serial or not (name or email):
            continue
        owners = assignments.setdefault(serial, [])
        for existing_name, existing_email in owners:
            same_owner = (
                existing_email == email
                if existing_email and email
                else bool(name and existing_name and existing_name == name)
            )
            if not same_owner:
                raise ValueError(
                    f"Serial number {_as_text(record, 'Serial number', 'IntuneGroup.SerialNumber')} "
                    "can be assigned to only one primary user."
                )
        owners.append((name, email))

    connection.execute("DELETE FROM inventory_devices")
    for position, record in enumerate(devices):
        serial = _as_text(record, "Serial number", "IntuneGroup.SerialNumber")
        connection.execute(
            """INSERT INTO inventory_devices (
                position, device_type, device_id, device_name, serial_number, normalized_serial,
                group_name, group_tag, manufacturer, model, compliance,
                warranty_start_date, warranty_end_date, duplicate_serial, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                position,
                _inventory_device_type(record),
                _as_text(record, "Device ID"),
                _as_text(record, "Device name"),
                serial,
                _serial_key(serial),
                _as_text(record, "IntuneGroup.GroupName"),
                _as_text(record, "IntuneGroup.GroupTag"),
                _as_text(record, "Manufacturer"),
                _as_text(record, "Model"),
                _as_text(record, "Compliance"),
                _as_text(record, "Warranty Start Date"),
                _as_text(record, "Warranty End Date"),
                int(record.get("Duplicate Serial") is True),
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _inventory_device_type(record: dict[str, Any]) -> str:
    asset_type = _as_text(record, "Asset type").strip()
    value = (asset_type or _as_text(record, "Device type", "Device Type")).strip().casefold()
    aliases = {
        "": "laptop",
        "laptop": "laptop",
        "firewall": "firewall",
        "ups": "ups",
        "accesspoint": "accesspoint",
        "access point": "accesspoint",
        "access point": "accesspoint",
        "switch": "switch",
        "switches": "switch",
    }
    if value not in aliases and asset_type:
        raise ValueError(f"Unsupported device type: {value}.")
    return aliases.get(value, "laptop")


def _replace_warranty(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    connection.execute("DELETE FROM warranty_records")
    for record in records:
        serial = _as_text(record, "Serial number")
        normalized = _serial_key(serial)
        if not normalized:
            continue
        connection.execute(
            """INSERT INTO warranty_records (
                normalized_serial, serial_number, warranty_start_date, warranty_end_date, data_json
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(normalized_serial) DO UPDATE SET
                serial_number=excluded.serial_number,
                warranty_start_date=excluded.warranty_start_date,
                warranty_end_date=excluded.warranty_end_date,
                data_json=excluded.data_json""",
            (
                normalized,
                serial,
                _as_text(record, "Warranty Start Date"),
                _as_text(record, "Warranty End Date"),
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_inventory(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM inventory_devices ORDER BY position, id"
    )]


def _read_warranty(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM warranty_records ORDER BY serial_number"
    )]


def _replace_replacement_history(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    replacement_ids: set[str] = set()
    for record in records:
        replacement_id = _as_text(record, "Replacement ID").strip()
        if not replacement_id:
            raise ValueError("Every replacement record must have a Replacement ID.")
        normalized_id = replacement_id.casefold()
        if normalized_id in replacement_ids:
            raise ValueError(f"Duplicate Replacement ID: {replacement_id}.")
        replacement_ids.add(normalized_id)

    connection.execute("DELETE FROM replacement_history")
    for position, record in enumerate(records):
        connection.execute(
            """INSERT INTO replacement_history (
                replacement_id, position, old_serial, new_serial, data_json
            ) VALUES (?, ?, ?, ?, ?)""",
            (
                _as_text(record, "Replacement ID").strip(),
                position,
                _as_text(record, "Old Device Serial Number").strip(),
                _as_text(record, "New Device Serial Number").strip(),
                json.dumps({key: value for key, value in record.items() if key != "Handover Eligibility"}, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_replacement_history(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM replacement_history ORDER BY position, replacement_id"
    )]


def _replace_checkout_history(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    event_ids: set[str] = set()
    checked_out: dict[str, str] = {}
    for record in records:
        event_id = _as_text(record, "Event ID").strip()
        asset_key = _as_text(record, "Asset key").strip()
        event_type = _as_text(record, "Event type").strip().casefold()
        event_date = _as_text(record, "Event date").strip()
        staff_name = _as_text(record, "Staff name").strip()
        if not event_id or not asset_key or not event_date or not staff_name:
            raise ValueError("Every checkout event must include an Event ID, Asset key, Event date, and Staff name.")
        if event_type not in {"checkout", "checkin"}:
            raise ValueError("Checkout event type must be checkout or checkin.")
        serial = _asset_serial(record)
        device_id = _as_text(record, "Device ID").strip().casefold()
        if serial:
            identity = f"serial:{serial}"
        elif device_id and device_id not in MISSING_IDENTIFIERS:
            identity = f"device:{device_id}"
        else:
            identity = asset_key.casefold()
        try:
            parsed_date = datetime.strptime(event_date, "%Y-%m-%d").date()
        except ValueError as error:
            raise ValueError("Checkout event date must use YYYY-MM-DD format.") from error
        expected_return = _as_text(record, "Expected return date").strip()
        if expected_return:
            try:
                expected_date = datetime.strptime(expected_return, "%Y-%m-%d").date()
            except ValueError as error:
                raise ValueError("Expected return date must use YYYY-MM-DD format.") from error
            if event_type == "checkout" and expected_date < parsed_date:
                raise ValueError("Expected return date cannot be before the checkout date.")
        normalized_id = event_id.casefold()
        if normalized_id in event_ids:
            raise ValueError(f"Duplicate checkout event ID: {event_id}.")
        event_ids.add(normalized_id)
        if event_type == "checkout":
            if identity in checked_out:
                raise ValueError(
                    f"Asset {_as_text(record, 'Serial number', 'Device ID') or asset_key} "
                    f"is already checked out to {checked_out[identity]}."
                )
            checked_out[identity] = staff_name
        else:
            checked_out.pop(identity, None)

    connection.execute("DELETE FROM checkout_history")
    for position, record in enumerate(records):
        connection.execute(
            """INSERT INTO checkout_history (event_id, position, asset_key, event_date, data_json)
               VALUES (?, ?, ?, ?, ?)""",
            (
                _as_text(record, "Event ID").strip(),
                position,
                _as_text(record, "Asset key").strip(),
                _as_text(record, "Event date").strip(),
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_checkout_history(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM checkout_history ORDER BY position, event_id"
    )]


def _replace_users(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    user_ids: set[str] = set()
    emails: set[str] = set()
    for record in records:
        user_id = _as_text(record, "User ID").strip()
        name = _as_text(record, "Name").strip()
        email = _as_text(record, "Email").strip()
        if not user_id or not name:
            raise ValueError("Every user must include a User ID and Name.")
        if user_id.casefold() in user_ids:
            raise ValueError(f"Duplicate user ID: {user_id}.")
        user_ids.add(user_id.casefold())
        normalized_email = email.casefold()
        if normalized_email:
            if "@" not in normalized_email or normalized_email.startswith("@") or normalized_email.endswith("@"):
                raise ValueError(f"Invalid user email address: {email}.")
            if normalized_email in emails:
                raise ValueError(f"Duplicate user email address: {email}.")
            emails.add(normalized_email)

    connection.execute("DELETE FROM users")
    for position, record in enumerate(records):
        email = _as_text(record, "Email").strip()
        connection.execute(
            """INSERT INTO users (user_id, position, name, email, normalized_email, data_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                _as_text(record, "User ID").strip(),
                position,
                _as_text(record, "Name").strip(),
                email,
                email.casefold(),
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_users(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM users ORDER BY position, user_id"
    )]


def _read_asset_field_options(connection: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for row in connection.execute(
        "SELECT field_name, value, is_legacy FROM asset_field_options ORDER BY field_name, is_legacy, position, value COLLATE NOCASE"
    ):
        result.setdefault(row["field_name"], []).append({"value": row["value"], "legacy": bool(row["is_legacy"])})
    return result


def _active_checkout_serials(connection: sqlite3.Connection) -> set[str]:
    latest = _latest_checkout_events(connection)
    return {serial for serial, event in latest.items()
            if _as_text(event, "Event type").casefold() == "checkout"}


def _latest_checkout_events(connection: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for event in _read_checkout_history(connection):
        serial = _asset_serial(event)
        if serial:
            latest[serial] = event
    return latest


def _device_staff_identity(connection: sqlite3.Connection, device: dict[str, Any], checkout: dict[str, Any] | None = None) -> dict[str, Any]:
    name = _as_text(checkout or {}, "Staff name") or _as_text(device, "Primary user display name")
    email = _as_text(checkout or {}, "Staff email") or _as_text(device, "Primary user email address", "Primary user UPN")
    user_row = None
    if email:
        user_row = connection.execute(
            "SELECT user_id, name, email FROM users WHERE normalized_email=? COLLATE NOCASE LIMIT 1",
            (email.strip().casefold(),),
        ).fetchone()
    if not user_row and name:
        matches = connection.execute(
            "SELECT user_id, name, email FROM users WHERE name=? COLLATE NOCASE ORDER BY position LIMIT 2",
            (name.strip(),),
        ).fetchall()
        if len(matches) == 1:
            user_row = matches[0]
    if user_row:
        return {"id": user_row["user_id"], "name": user_row["name"], "email": user_row["email"]}
    return {"id": "", "name": name.strip(), "email": email.strip()}


ACTIVE_ASSIGNED_STATUS_NAMES = {"deployed", "in use", "active", "checked out", "assigned", "in service"}


def _active_assigned_device(device: dict[str, Any], active_checkouts: set[str]) -> bool:
    serial = _asset_serial(device)
    status = _as_text(device, "Status Label", "Status").strip().casefold()
    assigned = bool(_as_text(device, "Primary user email address", "Primary user UPN", "Primary user display name"))
    active_checkout_keys = {_serial_key(value) for value in active_checkouts}
    return bool(serial and (_serial_key(serial) in active_checkout_keys
                            or status in ACTIVE_ASSIGNED_STATUS_NAMES
                            or (assigned and not status)))


def _eligible_handout_device(record: dict[str, Any], active_checkouts: set[str] | None = None) -> bool:
    serial = _asset_serial(record)
    if active_checkouts and serial in active_checkouts:
        return False
    if _as_text(record, "Primary user email address", "Primary user UPN", "Primary user display name"):
        return False
    status = _as_text(record, "Status Label", "Status").strip().casefold()
    if not status:
        return True
    return status in ELIGIBLE_HANDOUT_STATUS_NAMES


def _assigned_device_status_label(connection: sqlite3.Connection) -> str:
    labels = _read_status_labels(connection)
    deployed = next((label["name"] for label in labels
                     if label["name"].casefold() == "deployed" and label["type"] == "Deployable"), None)
    if deployed:
        return deployed
    deployable = next((label["name"] for label in labels if label["type"] == "Deployable"), None)
    if not deployable:
        raise ValueError("Configure a Deployable status label before assigning a replacement device.")
    return deployable


def _inventory_row_for_serial(connection: sqlite3.Connection, serial: str) -> sqlite3.Row | None:
    normalized = _serial_key(serial)
    if not normalized:
        return None
    rows = connection.execute(
        "SELECT id, data_json FROM inventory_devices WHERE normalized_serial=? ORDER BY position, id",
        (normalized,),
    ).fetchall()
    if len(rows) > 1:
        raise ValueError(f"Serial number {serial} matches multiple inventory records; resolve the duplicate first.")
    return rows[0] if rows else None


def _apply_replacement_links(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    current_rows = connection.execute("SELECT data_json FROM inventory_devices ORDER BY position, id").fetchall()
    active_checkouts = _active_checkout_serials(connection)
    current: dict[str, dict[str, Any]] = {}
    for row in current_rows:
        device = json.loads(row["data_json"])
        serial = _asset_serial(device)
        if serial:
            current[serial] = device
    incoming_by_serial: dict[str, list[dict[str, Any]]] = {}
    for device in records:
        serial = _asset_serial(device)
        if serial:
            incoming_by_serial.setdefault(serial, []).append(device)
    history_by_old_serial: dict[str, list[dict[str, Any]]] = {}
    for event in _read_replacement_history(connection):
        old_key = _serial_key(_as_text(event, "Old Device Serial Number"))
        if old_key:
            history_by_old_serial.setdefault(old_key, []).append(event)
    replacement_targets: set[str] = set()
    for source in records:
        source_serial = _asset_serial(source)
        replacement_serial = _as_text(source, "Replaced By Device Serial Number").strip()
        if not replacement_serial:
            continue
        if _serial_key(source_serial) == _serial_key(replacement_serial):
            raise ValueError("A device cannot replace itself.")
        previous_serial = _as_text(current.get(source_serial, {}), "Replaced By Device Serial Number").strip()
        if not previous_serial:
            previous_events = sorted(history_by_old_serial.get(_serial_key(source_serial), []),
                                     key=lambda event: (_as_text(event, "Replacement Date"), _as_text(event, "Replacement ID")))
            previous_serial = " → ".join(_as_text(event, "New Device Serial Number") for event in previous_events)
        if _serial_key(previous_serial) == _serial_key(replacement_serial):
            continue
        target_key = _serial_key(replacement_serial)
        if target_key in replacement_targets:
            raise ValueError("A replacement device can be linked to only one old device in an inventory update.")
        replacement_targets.add(target_key)
        target_row = _inventory_row_for_serial(connection, replacement_serial)
        if not target_row:
            raise ValueError("The replacement device is no longer in inventory. Refresh inventory and choose another device.")
        target = json.loads(target_row["data_json"])
        if not _eligible_handout_device(target, active_checkouts):
            raise ValueError("The replacement device is no longer available for handout. Search again and choose another device.")
        matching_incoming = incoming_by_serial.get(_serial_key(replacement_serial), [])
        if len(matching_incoming) != 1:
            raise ValueError("The selected replacement device has an ambiguous serial number in the inventory update.")
        incoming_target = matching_incoming[0]
        incoming_target["Status Label"] = _assigned_device_status_label(connection)
        incoming_target["Primary user display name"] = _as_text(source, "Primary user display name")
        incoming_target["Primary user email address"] = _as_text(source, "Primary user email address", "Primary user UPN")
        incoming_target["Primary user UPN"] = incoming_target["Primary user email address"]


def _save_replacement_record(connection: sqlite3.Connection, payload: Any) -> int:
    if not isinstance(payload, dict) or not isinstance(payload.get("record"), dict):
        raise ValueError("Replacement save must include a record object.")
    record = dict(payload["record"])
    user_id = str(payload.get("staffUserId") or "").strip()
    if not user_id:
        raise ValueError("Choose a staff member from the User directory.")
    user_row = connection.execute(
        "SELECT data_json FROM users WHERE user_id=? COLLATE NOCASE", (user_id,)
    ).fetchone()
    if not user_row:
        raise ValueError("The selected staff member no longer exists. Search and select them again.")
    user = json.loads(user_row["data_json"])
    name = _as_text(user, "Name").strip()
    email = _as_text(user, "Email").strip()
    if not name or not email:
        raise ValueError("The selected user must have both a staff name and email in the User directory.")
    if _as_text(record, "Staff Member Name").strip().casefold() != name.casefold() \
            or _as_text(record, "Staff Email").strip().casefold() != email.casefold():
        raise ValueError("Staff details changed. Select the staff member again before saving.")
    record["Staff Member Name"] = name
    record["Staff Email"] = email
    record.pop("Handover Eligibility", None)
    replacement_id = _as_text(record, "Replacement ID").strip()
    old_serial = _as_text(record, "Old Device Serial Number").strip()
    new_serial = _as_text(record, "New Device Serial Number").strip()
    if not replacement_id or not new_serial:
        raise ValueError("Replacement ID and replacement device are required.")
    if old_serial and _serial_key(old_serial) == _serial_key(new_serial):
        raise ValueError("A device cannot replace itself.")
    try:
        datetime.strptime(_as_text(record, "Replacement Date"), "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("Replacement Date must use YYYY-MM-DD format.") from error

    records = _read_replacement_history(connection)
    existing_index = next((index for index, item in enumerate(records)
                           if _as_text(item, "Replacement ID").casefold() == replacement_id.casefold()), None)
    if payload.get("existingId") and (existing_index is None or _as_text(records[existing_index], "Replacement ID") != payload["existingId"]):
        raise ValueError("This replacement record changed or was removed. Reload history and try again.")
    if not payload.get("existingId") and existing_index is not None:
        raise ValueError("That replacement record ID already exists.")

    if old_serial:
        old_target = _inventory_row_for_serial(connection, old_serial)
        if not old_target:
            raise ValueError("The old device serial was not found in inventory.")
        old_device = json.loads(old_target["data_json"])
        if not _active_assigned_device(old_device, _active_checkout_serials(connection)):
            raise ValueError("The old device is no longer in an active assigned state.")
        latest_old_events = {_serial_key(_asset_serial(event)): event for event in _read_checkout_history(connection)
                             if _asset_serial(event)}
        old_identity = _device_staff_identity(connection, old_device, latest_old_events.get(_serial_key(old_serial)))
        same_staff = old_identity.get("id", "").casefold() == user_id.casefold()
        if not same_staff and not old_identity.get("id"):
            same_staff = old_identity.get("email", "").strip().casefold() == email.casefold()
        if not same_staff:
            raise ValueError("The old device is not assigned to the selected staff member.")
    else:
        active_checkouts = _active_checkout_serials(connection)
        latest_events = {_serial_key(_asset_serial(event)): event for event in _read_checkout_history(connection)
                         if _asset_serial(event)}
        assigned_count = 0
        for row in connection.execute("SELECT data_json FROM inventory_devices"):
            device = json.loads(row["data_json"])
            if not _active_assigned_device(device, active_checkouts):
                continue
            identity = _device_staff_identity(connection, device, latest_events.get(_serial_key(_asset_serial(device))))
            if identity.get("id", "").casefold() == user_id.casefold():
                assigned_count += 1
        if assigned_count:
            raise ValueError("Select one of this staff member's active assigned devices, or clear the assignment in inventory first.")

    old_target_serial = _as_text(records[existing_index], "New Device Serial Number") if existing_index is not None else ""
    if old_target_serial and _serial_key(old_target_serial) != _serial_key(new_serial):
        prior_target = _inventory_row_for_serial(connection, old_target_serial)
        if prior_target:
            prior_device = json.loads(prior_target["data_json"])
            if (_as_text(prior_device, "Status Label").casefold() != "deployed"
                    or _as_text(prior_device, "Primary user email address", "Primary user UPN").casefold() != email.casefold()):
                raise ValueError("The previous replacement device has changed since this event. Resolve its assignment before editing this record.")
            prior_device["Status Label"] = "Ready to Deploy"
            prior_device["Primary user display name"] = ""
            prior_device["Primary user email address"] = ""
            prior_device["Primary user UPN"] = ""
            connection.execute("UPDATE inventory_devices SET data_json=? WHERE id=?",
                               (json.dumps(prior_device, ensure_ascii=False, separators=(",", ":")), prior_target["id"]))

    target = _inventory_row_for_serial(connection, new_serial)
    if not target:
        raise ValueError("The replacement device is no longer in inventory. Refresh inventory and choose another device.")
    target_record = json.loads(target["data_json"])
    is_same_existing_target = bool(old_target_serial and _serial_key(old_target_serial) == _serial_key(new_serial))
    if not _eligible_handout_device(target_record, _active_checkout_serials(connection)) and not is_same_existing_target:
        raise ValueError("The replacement device is no longer available for handout. Search again and choose an available device.")
    target_record["Status Label"] = _assigned_device_status_label(connection)
    target_record["Primary user display name"] = name
    target_record["Primary user email address"] = email
    target_record["Primary user UPN"] = email
    connection.execute("UPDATE inventory_devices SET data_json=? WHERE id=?",
                       (json.dumps(target_record, ensure_ascii=False, separators=(",", ":")), target["id"]))

    if existing_index is None:
        records.append(record)
    else:
        records[existing_index] = record
    _replace_replacement_history(connection, records)
    return len(records)


DEFAULT_STATUS_LABELS = [
    {"id": "ready-to-deploy", "name": "Ready to Deploy", "type": "Deployable"},
    {"id": "deployed", "name": "Deployed", "type": "Deployable"},
    {"id": "awaiting-reimaging", "name": "Awaiting Re-Imaging", "type": "Pending"},
    {"id": "in-repair", "name": "In Repair", "type": "Undeployable"},
    {"id": "decommissioned", "name": "Decommissioned", "type": "Archived"},
    {"id": "archived", "name": "Archived", "type": "Archived"},
]
STATUS_LABEL_TYPES = {"Undeployable", "Deployable", "Archived", "Pending"}


def _replace_status_labels(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for record in records:
        label_id = str(record.get("id") or "").strip()
        name = str(record.get("name") or "").strip()
        label_type = str(record.get("type") or "").strip()
        if not label_id or not name or label_type not in STATUS_LABEL_TYPES:
            raise ValueError("Every status label needs an ID, name, and valid characteristic.")
        if label_id.casefold() in seen_ids or name.casefold() in seen_names:
            raise ValueError("Status label IDs and names must be unique.")
        seen_ids.add(label_id.casefold())
        seen_names.add(name.casefold())
    connection.execute("DELETE FROM asset_status_labels")
    for position, record in enumerate(records):
        label = {"id": str(record["id"]).strip(), "name": str(record["name"]).strip(), "type": str(record["type"]).strip()}
        connection.execute(
            "INSERT INTO asset_status_labels(label_id, position, name, label_type, data_json) VALUES (?, ?, ?, ?, ?)",
            (label["id"], position, label["name"], label["type"], json.dumps(label, ensure_ascii=False)),
        )


def _read_status_labels(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = [json.loads(row[0]) for row in connection.execute(
        "SELECT data_json FROM asset_status_labels ORDER BY position, label_id"
    )]
    migration = connection.execute(
        "SELECT 1 FROM app_metadata WHERE key='status_labels_decommissioned_migrated'"
    ).fetchone()
    if migration is None:
        if rows:
            if not any(label["id"].casefold() == "decommissioned" or label["name"].casefold() == "decommissioned" for label in rows):
                rows.append(next(label for label in DEFAULT_STATUS_LABELS if label["id"] == "decommissioned"))
        else:
            rows = list(DEFAULT_STATUS_LABELS)
        _replace_status_labels(connection, rows)
        connection.execute(
            "INSERT INTO app_metadata(key, value) VALUES('status_labels_decommissioned_migrated', '1')"
        )
    return rows


class InventoryRequestHandler(SimpleHTTPRequestHandler):
    """Serve the static app and its same-origin inventory API."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _run_json_search(self, label: str, search) -> None:
        try:
            results = search()
            self._send_json(200, {"results": results})
        except Exception as error:
            self.log_error("%s search failed: %s", label, error)
            traceback.print_exc(file=sys.stderr)
            self._send_json(500, {"error": str(error) or f"{label} search failed."})

    def _logged_search_rows(self, label: str, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        self.log_message("SEARCH %s SQL=%s PARAMS=%r", label, sql, params)
        with _DB_LOCK, database_connection() as connection:
            return connection.execute(sql, params).fetchall()

    def _search_users(self, query_string: str) -> list[dict[str, str]]:
        params = parse_qs(query_string, keep_blank_values=False, max_num_fields=5)
        query = params.get("q", [""])[0].strip()
        if not query:
            return []
        pattern = _like_pattern(query)
        sql = ("SELECT user_id, name, email FROM users "
               "WHERE LOWER(name) LIKE LOWER(?) ESCAPE '\\' "
               "OR LOWER(email) LIKE LOWER(?) ESCAPE '\\' "
               "ORDER BY name COLLATE NOCASE, user_id LIMIT 40")
        rows = self._logged_search_rows("users", sql, (pattern, pattern))
        return [{"id": row["user_id"], "name": row["name"], "email": row["email"]} for row in rows]

    def _search_available_replacements(self, query_string: str) -> list[dict[str, Any]]:
        params = parse_qs(query_string, keep_blank_values=False, max_num_fields=8)
        query = params.get("q", [""])[0].strip()
        excluded = {_serial_key(value) for value in params.get("exclude", [""])[0].split("|") if value.strip()}
        if not query:
            return []
        pattern = _like_pattern(query)
        sql = ("SELECT data_json FROM inventory_devices "
               "WHERE LOWER(device_name) LIKE LOWER(?) ESCAPE '\\' "
               "OR LOWER(serial_number) LIKE LOWER(?) ESCAPE '\\' "
               "OR LOWER(data_json) LIKE LOWER(?) ESCAPE '\\' "
               "ORDER BY position, id")
        rows = self._logged_search_rows("available-replacements", sql, (pattern, pattern, pattern))
        with _DB_LOCK, database_connection() as connection:
            active_checkouts = _active_checkout_serials(connection)
        devices = []
        needle = query.casefold()
        for row in rows:
            device = json.loads(row["data_json"])
            serial = _asset_serial(device).strip()
            fields = [serial, _as_text(device, "Model"), _as_text(device, "Country"),
                      _as_text(device, "Fixed Asset Number"), _as_text(device, "Device name", "IntuneGroup.DeviceName")]
            if not serial or _serial_key(serial) in excluded or not _eligible_handout_device(device, active_checkouts):
                continue
            if not any(needle in value.casefold() for value in fields):
                continue
            devices.append({"serial": serial, "model": fields[1], "country": fields[2],
                            "fixedAssetNumber": fields[3], "deviceName": fields[4],
                            "status": _as_text(device, "Status Label", "Status") or "Ready to Deploy"})
            if len(devices) == 40:
                break
        return devices

    def _search_assigned_devices(self, query_string: str) -> list[dict[str, Any]]:
        params = parse_qs(query_string, keep_blank_values=False, max_num_fields=8)
        query = params.get("q", [""])[0].strip()
        user_id = params.get("userId", [""])[0].strip()
        if not query and not user_id:
            return []
        if query:
            pattern = _like_pattern(query)
            sql = ("SELECT data_json FROM inventory_devices "
                   "WHERE LOWER(device_name) LIKE LOWER(?) ESCAPE '\\' "
                   "OR LOWER(serial_number) LIKE LOWER(?) ESCAPE '\\' "
                   "OR LOWER(data_json) LIKE LOWER(?) ESCAPE '\\' "
                   "ORDER BY position, id")
            rows = self._logged_search_rows("assigned-devices", sql, (pattern, pattern, pattern))
        else:
            sql = "SELECT data_json FROM inventory_devices ORDER BY position, id"
            rows = self._logged_search_rows("assigned-devices", sql)
        with _DB_LOCK, database_connection() as connection:
            active_checkouts = _active_checkout_serials(connection)
            latest_events = {_serial_key(_asset_serial(event)): event for event in _read_checkout_history(connection)
                             if _asset_serial(event)}
            if user_id:
                user_sql = "SELECT 1 FROM users WHERE user_id=? COLLATE NOCASE"
                self.log_message("SEARCH assigned-devices SQL=%s PARAMS=%r", user_sql, (user_id,))
                if not connection.execute(user_sql, (user_id,)).fetchone():
                    return []
            devices = []
            needle = query.casefold()
            for row in rows:
                device = json.loads(row["data_json"])
                serial = _asset_serial(device).strip()
                if not serial or not _active_assigned_device(device, active_checkouts):
                    continue
                identity = _device_staff_identity(connection, device, latest_events.get(_serial_key(serial)))
                if user_id and identity.get("id", "").casefold() != user_id.casefold():
                    continue
                fields = [serial, _as_text(device, "Device name", "IntuneGroup.DeviceName"),
                          _as_text(device, "Model"), identity.get("name", ""), identity.get("email", "")]
                if query and not any(needle in value.casefold() for value in fields):
                    continue
                devices.append({"serial": serial, "deviceName": fields[1], "model": fields[2],
                                "country": _as_text(device, "Country"),
                                "fixedAssetNumber": _as_text(device, "Fixed Asset Number"),
                                "status": _as_text(device, "Status Label", "Status"), "staff": identity})
            return devices[:80]

    def _read_json(self) -> Any:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            raise ValueError("Request body is too large.")
        try:
            return json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Request body must contain valid JSON.") from error

    def _read_backup_upload(self) -> Path:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if content_length <= 0 or content_length > MAX_DATABASE_BACKUP_BYTES:
            raise ValueError("Backup file is empty or exceeds the 512 MB upload limit.")
        DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        descriptor, upload_name = tempfile.mkstemp(prefix="nexit-restore-", suffix=".db", dir=DATABASE_PATH.parent)
        upload_path = Path(upload_name)
        remaining = content_length
        try:
            with os.fdopen(descriptor, "wb") as upload:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Backup upload ended before the complete file was received.")
                    upload.write(chunk)
                    remaining -= len(chunk)
            return upload_path
        except (OSError, ValueError):
            upload_path.unlink(missing_ok=True)
            raise

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/api/users/search":
            self._run_json_search("users", lambda: self._search_users(parsed.query))
            return
        if parsed.path == "/api/inventory/available-replacements":
            self._run_json_search("available-replacements", lambda: self._search_available_replacements(parsed.query))
            return
        if parsed.path == "/api/inventory/assigned-devices":
            self._run_json_search("assigned-devices", lambda: self._search_assigned_devices(parsed.query))
            return
        if parsed.path == "/api/field-options":
            try:
                with _DB_LOCK, database_connection() as connection:
                    self._send_json(200, {"options": _read_asset_field_options(connection)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Field option query failed: %s", error)
                self._send_json(500, {"error": "Could not load device field options."})
            return
        if parsed.path == "/api/health":
            self._send_json(200, {
                "status": "ok",
                "database": str(DATABASE_PATH),
                "apiVersion": API_VERSION,
                "replacementAutocomplete": True,
            })
            return
        if parsed.path == "/api/backup":
            try:
                with _DB_LOCK:
                    backup_path = _create_database_backup()
            except (OSError, sqlite3.Error) as error:
                self.log_error("Database backup failed: %s", error)
                self._send_json(500, {"error": "Could not create a SQLite database backup."})
                return
            try:
                file_size = backup_path.stat().st_size
                if file_size > MAX_DATABASE_BACKUP_BYTES:
                    self._send_json(413, {"error": "Database backup exceeds the 512 MB restore limit."})
                    return
                filename = f"nexit-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.sqlite3")
                self.send_header("Content-Length", str(file_size))
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with backup_path.open("rb") as backup_file:
                    shutil.copyfileobj(backup_file, self.wfile)
            finally:
                backup_path.unlink(missing_ok=True)
            return
        if parsed.path == "/api/bootstrap":
            try:
                with _DB_LOCK, database_connection() as connection:
                    records = _read_inventory(connection)
                    replacements = _read_replacement_history(connection)
                    checkout_history = _read_checkout_history(connection)
                    status_labels = _read_status_labels(connection)
                options = filter_options(records, status_labels=status_labels, checkout_history=checkout_history)
                options["warrantyStatus"] = options.pop("warranty", [])
                options["plannedAction"] = options.pop("planned_action", [])
                options["assetStatus"] = options.pop("asset_status", [])
                options["onlineStatus"] = options.pop("online_status", [])
                self._send_json(200, {
                    "filterOptions": options,
                    "sourceRecordCount": len(records),
                    "replacementRecordCount": len(replacements),
                    "checkoutEventCount": len(checkout_history),
                })
            except (OSError, sqlite3.Error) as error:
                self.log_error("Dashboard bootstrap failed: %s", error)
                self._send_json(500, {"error": "Could not load dashboard filter options."})
            return
        if parsed.path in {"/api/dashboard", "/api/dashboard/records"}:
            try:
                params = parse_qs(parsed.query, keep_blank_values=False, max_num_fields=20)
                filter_names = {
                    "country": "country", "category": "category", "assetStatus": "asset_status",
                    "onlineStatus": "online_status", "os": "os", "manufacturer": "manufacturer",
                    "warrantyStatus": "warranty", "department": "department", "status": "status",
                    "lifecycle": "lifecycle", "plannedAction": "planned_action", "model": "model",
                }
                filters = {field: params[name][0] for name, field in filter_names.items() if params.get(name)}
                with _DB_LOCK, database_connection() as connection:
                    records = _read_inventory(connection)
                    status_labels = _read_status_labels(connection)
                    checkout_history = _read_checkout_history(connection)
                if parsed.path == "/api/dashboard/records":
                    metric = params.get("metric", [""])[0]
                    indexes = matching_record_indexes(records, filters, metric, status_labels=status_labels, checkout_history=checkout_history)
                    self._send_json(200, {"recordIndexes": indexes})
                else:
                    self._send_json(200, build_dashboard(records, filters, status_labels=status_labels, checkout_history=checkout_history))
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Dashboard query failed: %s", error)
                self._send_json(500, {"error": "Could not load dashboard data."})
            return
        if parsed.path.startswith("/api/"):
            self._send_json(404, {"error": f"API route not found: {parsed.path}"})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/replacement-history/save":
            try:
                payload = self._read_json()
                with _DB_LOCK, database_connection() as connection:
                    saved = _save_replacement_record(connection, payload)
                    response = {
                        "saved": saved,
                        "inventory": _read_inventory(connection),
                        "replacementHistory": _read_replacement_history(connection),
                    }
                self._send_json(200, response)
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Replacement record save failed: %s", error)
                self._send_json(500, {"error": "Could not save replacement record and update device assignment."})
            return
        if self.path == "/api/restore":
            upload_path = None
            try:
                upload_path = self._read_backup_upload()
                with _DB_LOCK:
                    _restore_database_backup(upload_path)
                self._send_json(200, {"restored": True})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Database restore failed: %s", error)
                self._send_json(500, {"error": "Could not restore the SQLite database."})
            finally:
                if upload_path is not None:
                    upload_path.unlink(missing_ok=True)
            return
        if self.path == "/api/checkin-primary-user":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Check-in data must be a JSON object.")
                inventory = payload.get("inventory")
                checkout_history = payload.get("checkoutHistory")
                if not isinstance(inventory, list) or not all(isinstance(row, dict) for row in inventory):
                    raise ValueError("Inventory data must be an array of records.")
                if not isinstance(checkout_history, list) or not all(isinstance(row, dict) for row in checkout_history):
                    raise ValueError("Checkout history data must be an array of records.")
                with _DB_LOCK, database_connection() as connection:
                    _replace_inventory(connection, inventory)
                    _replace_checkout_history(connection, checkout_history)
                self._send_json(200, {
                    "savedInventory": len(inventory),
                    "savedCheckoutEvents": len(checkout_history),
                })
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Primary-user check-in failed: %s", error)
                self._send_json(500, {"error": "Could not save primary-user check-in to SQLite."})
            return
        if self.path != "/api/bootstrap":
            self._send_json(404, {"error": "API route not found."})
            return
        try:
            legacy = self._read_json()
            if not isinstance(legacy, dict):
                raise ValueError("Bootstrap data must be a JSON object.")
            with _DB_LOCK, database_connection() as connection:
                migrated = connection.execute(
                    "SELECT value FROM app_metadata WHERE key='legacy_localstorage_migrated'"
                ).fetchone()
                did_migrate = False
                if migrated is None:
                    has_inventory = connection.execute(
                        "SELECT 1 FROM inventory_devices LIMIT 1"
                    ).fetchone() is not None
                    has_warranty = connection.execute(
                        "SELECT 1 FROM warranty_records LIMIT 1"
                    ).fetchone() is not None
                    if not has_inventory and not has_warranty:
                        inventory = legacy.get("inventory", [])
                        warranty = legacy.get("warranty", [])
                        if not isinstance(inventory, list) or not all(isinstance(row, dict) for row in inventory):
                            inventory = []
                        if not isinstance(warranty, list) or not all(isinstance(row, dict) for row in warranty):
                            warranty = []
                        _replace_inventory(connection, inventory)
                        _replace_warranty(connection, warranty)
                        did_migrate = bool(inventory or warranty)
                    connection.execute(
                        "INSERT INTO app_metadata(key, value) VALUES('legacy_localstorage_migrated', '1')"
                    )
                response = {
                    "inventory": _read_inventory(connection),
                    "warranty": _read_warranty(connection),
                    "replacementHistory": _read_replacement_history(connection),
                    "checkoutHistory": _read_checkout_history(connection),
                    "users": _read_users(connection),
                    "statusLabels": _read_status_labels(connection),
                    "fieldOptions": _read_asset_field_options(connection),
                    "migrated": did_migrate,
                }
            self._send_json(200, response)
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except (OSError, sqlite3.Error) as error:
            self.log_error("Database bootstrap failed: %s", error)
            self._send_json(500, {"error": "Could not initialize or read the SQLite database."})

    def do_PUT(self) -> None:
        table = {
            "/api/inventory": "inventory",
            "/api/warranty": "warranty",
            "/api/replacement-history": "replacement_history",
            "/api/checkout-history": "checkout_history",
            "/api/users": "users",
            "/api/status-labels": "status_labels",
        }.get(self.path)
        if table is None:
            self._send_json(404, {"error": "API route not found."})
            return
        try:
            records = self._read_json()
            if not isinstance(records, list) or not all(isinstance(row, dict) for row in records):
                raise ValueError("Request body must be a JSON array of records.")
            with _DB_LOCK, database_connection() as connection:
                if table == "inventory":
                    _apply_replacement_links(connection, records)
                    _replace_inventory(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM inventory_devices").fetchone()[0]
                elif table == "warranty":
                    _replace_warranty(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM warranty_records").fetchone()[0]
                elif table == "users":
                    _replace_users(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                elif table == "status_labels":
                    _replace_status_labels(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM asset_status_labels").fetchone()[0]
                else:
                    if table == "replacement_history":
                        _replace_replacement_history(connection, records)
                    else:
                        _replace_checkout_history(connection, records)
                    count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            self._send_json(200, {"saved": count})
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except (OSError, sqlite3.Error) as error:
            self.log_error("Database write failed: %s", error)
            self._send_json(500, {"error": "Could not save data to the SQLite database."})

    def log_message(self, format_string: str, *args: Any) -> None:
        super().log_message(format_string, *args)


def main() -> None:
    host = "127.0.0.1"
    port = 8000
    connect_database().close()
    server = ThreadingHTTPServer((host, port), InventoryRequestHandler)
    print(f"NexIT is running at http://localhost:{port}")
    print(f"SQLite database: {DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping NexIT server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
