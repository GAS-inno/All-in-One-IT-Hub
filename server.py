"""Local HTTP server and SQLite API for the NexIT asset inventory."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

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

def _serial_key(serial: Any) -> str:
    value = str(serial or "").strip().upper()
    while True:
        base, marker, suffix = value.rpartition("--")
        if marker and suffix.isdigit():
            value = base
        else:
            break
    return "".join(value.split())


def _as_text(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "":
            return str(value)
    return ""


def _replace_inventory(connection: sqlite3.Connection, devices: list[dict[str, Any]]) -> None:
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

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/api/health":
            self._send_json(200, {"status": "ok", "database": str(DATABASE_PATH)})
            return
        if parsed.path == "/api/bootstrap":
            try:
                with _DB_LOCK, database_connection() as connection:
                    records = _read_inventory(connection)
                    replacements = _read_replacement_history(connection)
                options = filter_options(records)
                options["warrantyStatus"] = options.pop("warranty", [])
                options["plannedAction"] = options.pop("planned_action", [])
                self._send_json(200, {"filterOptions": options, "sourceRecordCount": len(records), "replacementRecordCount": len(replacements)})
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
                else:
                    _replace_replacement_history(connection, records)
                    count = connection.execute("SELECT COUNT(*) FROM replacement_history").fetchone()[0]
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
