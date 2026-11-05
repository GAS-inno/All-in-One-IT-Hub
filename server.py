"""Local HTTP server and SQLite API for the NexIT asset inventory."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
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
MISSING_IDENTIFIERS = {"n/a", "na", "none", "null", "unknown", "-"}
_DB_LOCK = threading.RLock()


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
            email TEXT NOT NULL DEFAULT '',
            normalized_email TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_email
            ON users(normalized_email);
        CREATE TABLE IF NOT EXISTS app_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
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
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
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
            """INSERT INTO users (user_id, position, email, normalized_email, data_json)
               VALUES (?, ?, ?, ?, ?)""",
            (
                _as_text(record, "User ID").strip(),
                position,
                email,
                email.casefold(),
                json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_users(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["data_json"]) for row in connection.execute(
        "SELECT data_json FROM users ORDER BY position, user_id"
    )]


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
        if parsed.path == "/api/health":
            self._send_json(200, {"status": "ok", "database": str(DATABASE_PATH)})
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
                options = filter_options(records)
                options["warrantyStatus"] = options.pop("warranty", [])
                options["plannedAction"] = options.pop("planned_action", [])
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
                filter_names = {"country": "country", "department": "department", "os": "os", "status": "status", "lifecycle": "lifecycle", "warrantyStatus": "warranty", "plannedAction": "planned_action", "model": "model"}
                filters = {field: params[name][0] for name, field in filter_names.items() if params.get(name)}
                with _DB_LOCK, database_connection() as connection:
                    records = _read_inventory(connection)
                if parsed.path == "/api/dashboard/records":
                    metric = params.get("metric", [""])[0]
                    indexes = matching_record_indexes(records, filters, metric)
                    self._send_json(200, {"recordIndexes": indexes})
                else:
                    self._send_json(200, build_dashboard(records, filters))
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Dashboard query failed: %s", error)
                self._send_json(500, {"error": "Could not load dashboard data."})
            return
        super().do_GET()

    def do_POST(self) -> None:
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
                    _replace_inventory(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM inventory_devices").fetchone()[0]
                elif table == "warranty":
                    _replace_warranty(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM warranty_records").fetchone()[0]
                elif table == "users":
                    _replace_users(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
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
