"""Local HTTP server and SQLite API for the NexIT asset inventory."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
import traceback
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from constants import CONDITION, CONDITION_LABELS, DEPLOYMENT_STATUS, DISPOSITION_METHOD, OLD_DEVICE_OUTCOME
from dashboard_metrics import build_dashboard, filter_options, matching_record_indexes
from date_utils import (
    excel_serial_to_iso as _excel_serial_to_iso,
    format_iso_to_display as iso_to_display_date,
    normalize_date_field as _normalize_date_field,
    parse_date_to_iso as normalize_inventory_date,
    parse_iso_date,
    require_iso_date,
)

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

AUTH_SESSION_COOKIE = "nexit_session"
AUTH_INACTIVITY_TIMEOUT = timedelta(minutes=30)
AUTH_SESSION_ABSOLUTE_TIMEOUT = timedelta(hours=12)
AUTH_PASSWORD_HASH_ITERATIONS = 390000
AUTH_LOGIN_RATE_LIMIT_WINDOW = timedelta(minutes=15)
AUTH_LOGIN_RATE_LIMIT_MAX_FAILURES = 10
AUTH_LOGIN_RATE_LIMIT_LOCKOUT = timedelta(minutes=15)
ASSET_FIELD_ENUMS = {
    "Replacement Status": ("Not replaced", "Replaced", "Pending replacement", "In progress"),
    "Staff Member Lifecycle Status": ("Active", "Leaver", "Contractor", "Unknown"),
    "Asset type": ("Laptop", "Firewall", "UPS", "AccessPoint", "Switch"),
}
STAFF_TYPE_SOURCE_AUTO = "auto"
STAFF_TYPE_SOURCE_MANUAL = "manual"
STAFF_TYPE_EXTERNAL = "External Staff"
STAFF_TYPE_INTERNAL = "Internal Staff"
ELIGIBLE_HANDOUT_STATUS_NAMES = {
    "ready to deploy", "deployable", "available", "available for handover", "ready for handover",
}



REMOVED_INTUNE_KEYS = {
    "IntuneGroup.DeviceName",
    "Intune SerialNumber",
    "IntuneGroup.Model",
    "Intune Group Model",
    "IntuneGroup.Manufacturer",
    "Intune Group Manufacturer",
}
INTUNE_GROUP_NAME_KEY = "Intune GroupName"
LEGACY_INTUNE_GROUP_NAME_KEYS = ("IntuneGroup.GroupName", "Intune.GroupName", "IntuneGroup GroupName")


def normalize_inventory_record_keys(record: dict[str, Any]) -> dict[str, Any]:
    """Canonicalize keys: standardize Intune GroupName (user-requested), drop removed Intune fields."""
    normalized = dict(record)
    group_name = _as_text(normalized, INTUNE_GROUP_NAME_KEY, *LEGACY_INTUNE_GROUP_NAME_KEYS)
    for key in LEGACY_INTUNE_GROUP_NAME_KEYS:
        normalized.pop(key, None)
    if group_name or INTUNE_GROUP_NAME_KEY in record or any(key in record for key in LEGACY_INTUNE_GROUP_NAME_KEYS):
        normalized[INTUNE_GROUP_NAME_KEY] = group_name
    for key in REMOVED_INTUNE_KEYS:
        normalized.pop(key, None)
    return normalized



def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def hash_password(password: str) -> str:
    if not isinstance(password, str) or not password:
        raise ValueError("Password is required.")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, AUTH_PASSWORD_HASH_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        AUTH_PASSWORD_HASH_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations_text, salt_b64, digest_b64 = str(encoded or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
        salt = base64.b64decode(salt_b64.encode("ascii"))
        expected = base64.b64decode(digest_b64.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", str(password or "").encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


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
            purchase_date TEXT DEFAULT NULL,
            warranty_start_date TEXT NOT NULL DEFAULT '',
            warranty_end_date TEXT NOT NULL DEFAULT '',
            disposal_date TEXT DEFAULT NULL,
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
            UserID TEXT PRIMARY KEY COLLATE NOCASE,
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
        CREATE TABLE IF NOT EXISTS auth_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
            is_active INTEGER NOT NULL DEFAULT 1,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            failed_login_count INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            last_login_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_users_username ON auth_users(username COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS auth_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            ip_address TEXT,
            user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS auth_login_attempts (
            attempt_key TEXT PRIMARY KEY,
            username TEXT NOT NULL DEFAULT '',
            ip_address TEXT NOT NULL DEFAULT '',
            failed_count INTEGER NOT NULL DEFAULT 0,
            first_failed_at TEXT,
            locked_until TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_locked_until ON auth_login_attempts(locked_until);
        """
    )
    user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
    if "name" not in user_columns:
        connection.execute("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''")
    if "UserID" not in user_columns and "user_id" in user_columns:
        connection.execute("ALTER TABLE users RENAME COLUMN user_id TO UserID")
    if "staff_type" not in user_columns:
        connection.execute("ALTER TABLE users ADD COLUMN staff_type TEXT")
    if "staff_type_source" not in user_columns:
        connection.execute("ALTER TABLE users ADD COLUMN staff_type_source TEXT NOT NULL DEFAULT 'auto'")
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
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(inventory_devices)")}
    if "purchase_date" not in columns or "disposal_date" not in columns:
        # Option A (approved): safe recreate to position purchase/disposal near warranty columns.
        previous_foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.executescript("""
            CREATE TABLE inventory_devices_new (
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
                purchase_date TEXT DEFAULT NULL,
                warranty_start_date TEXT NOT NULL DEFAULT '',
                warranty_end_date TEXT NOT NULL DEFAULT '',
                disposal_date TEXT DEFAULT NULL,
                duplicate_serial INTEGER NOT NULL DEFAULT 0,
                data_json TEXT NOT NULL
            );
            INSERT INTO inventory_devices_new (
                id, position, device_type, device_id, device_name, serial_number, normalized_serial,
                group_name, group_tag, manufacturer, model, compliance,
                purchase_date, warranty_start_date, warranty_end_date, disposal_date,
                duplicate_serial, data_json
            )
            SELECT
                id, position, device_type, device_id, device_name, serial_number, normalized_serial,
                group_name, group_tag, manufacturer, model, compliance,
                NULLIF(trim(COALESCE(json_extract(data_json,'$."Purchase Date"'), json_extract(data_json,'$."purchase_date"'), '')), ''),
                warranty_start_date,
                warranty_end_date,
                NULLIF(trim(COALESCE(json_extract(data_json,'$."Disposal Date"'), json_extract(data_json,'$."disposal_date"'), '')), ''),
                duplicate_serial,
                data_json
            FROM inventory_devices;
            DROP TABLE inventory_devices;
            ALTER TABLE inventory_devices_new RENAME TO inventory_devices;
        """)
        connection.execute(f"PRAGMA foreign_keys={'ON' if previous_foreign_keys else 'OFF'}")
        # Recreate inventory triggers dropped with the old table.
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
        """)
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inventory_serial ON inventory_devices(normalized_serial)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_inventory_group ON inventory_devices(group_name, group_tag)")
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


def _public_auth_user(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    return {
        "id": int(data["id"]),
        "username": str(data.get("username") or ""),
        "role": str(data.get("role") or ""),
        "isActive": bool(data.get("is_active", 1)),
        "mustChangePassword": bool(data.get("must_change_password", 0)),
        "lastLoginAt": data.get("last_login_at"),
        "createdAt": data.get("created_at"),
        "updatedAt": data.get("updated_at"),
    }


def _normalize_username(username: Any) -> str:
    return " ".join(str(username or "").strip().split())


def _validate_new_password(password: Any) -> str:
    text = str(password or "")
    if len(text) < 8:
        raise ValueError("Password must be at least 8 characters.")
    return text


def _auth_rate_limit_key(username: str, ip_address: str) -> str:
    return f"{username.casefold()}|{ip_address or 'unknown'}"


def _check_login_rate_limit(connection: sqlite3.Connection, username: str, ip_address: str) -> None:
    key = _auth_rate_limit_key(username, ip_address)
    row = connection.execute(
        "SELECT locked_until FROM auth_login_attempts WHERE attempt_key=?",
        (key,),
    ).fetchone()
    if not row or not row["locked_until"]:
        return
    locked_until = _parse_iso_datetime(row["locked_until"])
    if locked_until and locked_until > _utc_now():
        raise ValueError("Too many failed login attempts. Try again later.")
    if locked_until:
        connection.execute(
            "UPDATE auth_login_attempts SET failed_count=0, locked_until=NULL, updated_at=? WHERE attempt_key=?",
            (_utc_now_iso(), key),
        )


def _record_login_failure(connection: sqlite3.Connection, username: str, ip_address: str) -> None:
    key = _auth_rate_limit_key(username, ip_address)
    now = _utc_now()
    now_iso = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    row = connection.execute(
        "SELECT failed_count, first_failed_at, locked_until FROM auth_login_attempts WHERE attempt_key=?",
        (key,),
    ).fetchone()
    failed_count = 1
    first_failed_at = now_iso
    if row:
        locked_until = _parse_iso_datetime(row["locked_until"])
        existing_first = _parse_iso_datetime(row["first_failed_at"]) or now
        if locked_until and locked_until > now:
            failed_count = int(row["failed_count"] or 0)
            first_failed_at = existing_first.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        elif now - existing_first <= AUTH_LOGIN_RATE_LIMIT_WINDOW:
            failed_count = int(row["failed_count"] or 0) + 1
            first_failed_at = existing_first.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    locked_until_value = None
    if failed_count >= AUTH_LOGIN_RATE_LIMIT_MAX_FAILURES:
        locked_until_value = (now + AUTH_LOGIN_RATE_LIMIT_LOCKOUT).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    connection.execute(
        """
        INSERT INTO auth_login_attempts(attempt_key, username, ip_address, failed_count, first_failed_at, locked_until, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET
          username=excluded.username,
          ip_address=excluded.ip_address,
          failed_count=excluded.failed_count,
          first_failed_at=excluded.first_failed_at,
          locked_until=excluded.locked_until,
          updated_at=excluded.updated_at
        """,
        (key, username.casefold(), ip_address or "", failed_count, first_failed_at, locked_until_value, now_iso),
    )


def _clear_login_failures(connection: sqlite3.Connection, username: str, ip_address: str) -> None:
    key = _auth_rate_limit_key(username, ip_address)
    connection.execute("DELETE FROM auth_login_attempts WHERE attempt_key=?", (key,))


def _create_session(connection: sqlite3.Connection, user_id: int, ip_address: str = "", user_agent: str = "") -> str:
    session_id = secrets.token_urlsafe(48)
    now = _utc_now()
    created_at = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    expires_at = (now + AUTH_SESSION_ABSOLUTE_TIMEOUT).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    connection.execute(
        """
        INSERT INTO auth_sessions(session_id, user_id, created_at, last_seen_at, expires_at, revoked_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        """,
        (session_id, int(user_id), created_at, created_at, expires_at, ip_address or "", (user_agent or "")[:512]),
    )
    return session_id


def _get_session_auth(connection: sqlite3.Connection, session_id: str, *, touch: bool = True) -> dict[str, Any] | None:
    if not session_id:
        return None
    row = connection.execute(
        """
        SELECT s.session_id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
               u.id, u.username, u.role, u.is_active, u.must_change_password, u.last_login_at, u.created_at AS user_created_at, u.updated_at
        FROM auth_sessions s
        JOIN auth_users u ON u.id = s.user_id
        WHERE s.session_id = ?
        """,
        (session_id,),
    ).fetchone()
    if row is None:
        return None
    now = _utc_now()
    revoked_at = _parse_iso_datetime(row["revoked_at"])
    expires_at = _parse_iso_datetime(row["expires_at"])
    last_seen_at = _parse_iso_datetime(row["last_seen_at"])
    if revoked_at or not int(row["is_active"] or 0):
        return None
    if not expires_at or expires_at <= now:
        connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL", (_utc_now_iso(), session_id))
        return None
    if not last_seen_at or now - last_seen_at > AUTH_INACTIVITY_TIMEOUT:
        connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL", (_utc_now_iso(), session_id))
        return None
    if touch:
        connection.execute("UPDATE auth_sessions SET last_seen_at=? WHERE session_id=?", (_utc_now_iso(), session_id))
    user = {
        "id": int(row["id"]),
        "username": str(row["username"] or ""),
        "role": str(row["role"] or ""),
        "is_active": int(row["is_active"] or 0),
        "must_change_password": int(row["must_change_password"] or 0),
        "last_login_at": row["last_login_at"],
        "created_at": row["user_created_at"],
        "updated_at": row["updated_at"],
    }
    return {"sessionId": session_id, "user": _public_auth_user(user)}


def _create_database_backup() -> Path:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    descriptor, backup_name = tempfile.mkstemp(prefix="nexit-backup-", suffix=".db", dir=DATABASE_PATH.parent)
    os.close(descriptor)
    backup_path = Path(backup_name)
    try:
        # Use an autocommit connection for backup to avoid implicit-transaction locks/hangs.
        source = sqlite3.connect(str(DATABASE_PATH), isolation_level=None)
        try:
            with closing(sqlite3.connect(backup_path)) as destination:
                source.backup(destination)
        finally:
            source.close()
        return backup_path
    except (OSError, sqlite3.Error):
        backup_path.unlink(missing_ok=True)
        raise


DATABASE_DATA_TABLES = (
    "inventory_devices",
    "warranty_records",
    "replacement_history",
    "checkout_history",
    "users",
    "asset_status_labels",
    "asset_field_options",
)


def _clear_database(connection: sqlite3.Connection) -> int:
    """Clear application data only. Preserve RBAC/auth accounts and sessions."""
    cleared = 0
    for table in DATABASE_DATA_TABLES:
        cursor = connection.execute(f"DELETE FROM {table}")
        cleared += cursor.rowcount or 0
    # Remove revoked/expired sessions opportunistically, but keep active auth state intact.
    return cleared


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


def _validate_device_status(record: dict[str, Any]) -> None:
    deployment_status = _as_text(record, "deployment_status").strip()
    condition = _as_text(record, "condition").strip()
    disposition_method = _as_text(record, "disposition_method").strip()
    is_archived = record.get("is_archived")
    if deployment_status and deployment_status not in DEPLOYMENT_STATUS:
        raise ValueError(f"Unknown deployment status: {deployment_status}.")
    if condition and condition not in CONDITION:
        raise ValueError(f"Unknown condition: {condition}.")
    if is_archived is not None and not isinstance(is_archived, bool):
        raise ValueError("Inventory is_archived must be a boolean.")
    if deployment_status == "Disposed" and condition not in ("End of Life",):
        raise ValueError("Deployment status 'Disposed' requires condition 'End of Life'.")
    if disposition_method and deployment_status not in ("Retired", "Disposed"):
        raise ValueError(f"Disposition method '{disposition_method}' requires deployment status 'Retired' or 'Disposed'.")
    if deployment_status == "Retired" and disposition_method and disposition_method not in DISPOSITION_METHOD:
        raise ValueError(f"Unknown disposition method: {disposition_method}.")


def _normalize_inventory_date_field(record: dict[str, Any], *keys: str, strict: bool = True) -> str:
    """Normalize the first present/non-empty date among keys to ISO YYYY-MM-DD and store back to canonical key."""
    return _normalize_date_field(record, *keys, strict=strict, canonical=keys[0] if keys else None)


def _replace_inventory(connection: sqlite3.Connection, devices: list[dict[str, Any]]) -> None:
    assignments: dict[str, list[tuple[str, str]]] = {}
    for record in devices:
        _validate_device_status(record)
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
        # Capture legacy values before canonicalization drops removed keys.
        serial = _as_text(record, "Serial number", "IntuneGroup.SerialNumber", "Intune SerialNumber")
        group_name = _as_text(record, INTUNE_GROUP_NAME_KEY, *LEGACY_INTUNE_GROUP_NAME_KEYS)
        group_tag = _as_text(record, "IntuneGroup.GroupTag", "Intune Group Tag", "Group Tag", "GroupTag")
        payload = normalize_inventory_record_keys(record)
        purchase_date = _normalize_inventory_date_field(payload, "Purchase Date", "purchase_date")
        warranty_start = _normalize_inventory_date_field(payload, "Warranty Start Date", "warranty_start_date", "Warranty start date")
        warranty_end = _normalize_inventory_date_field(payload, "Warranty End Date", "warranty_end_date", "Warranty end date")
        disposal_date = _normalize_inventory_date_field(payload, "Disposal Date", "disposal_date")
        # Keep standardized/canonical fields in payload.
        payload[INTUNE_GROUP_NAME_KEY] = group_name
        if group_tag or "Intune Group Tag" in record or "IntuneGroup.GroupTag" in record or "Group Tag" in record or "GroupTag" in record:
            payload["Intune Group Tag"] = group_tag
        if serial:
            payload["Serial number"] = serial
        connection.execute(
            """INSERT INTO inventory_devices (
                position, device_type, device_id, device_name, serial_number, normalized_serial,
                group_name, group_tag, manufacturer, model, compliance,
                purchase_date, warranty_start_date, warranty_end_date, disposal_date,
                duplicate_serial, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                position,
                _inventory_device_type(payload),
                _as_text(payload, "Device ID"),
                _as_text(payload, "Device name"),
                serial,
                _serial_key(serial),
                group_name,
                group_tag,
                _as_text(payload, "Manufacturer"),
                _as_text(payload, "Model"),
                _as_text(payload, "Compliance"),
                purchase_date or None,
                warranty_start or "",
                warranty_end or "",
                disposal_date or None,
                int(payload.get("Duplicate Serial") is True),
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
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
        "desktop": "desktop",
    }
    if value not in aliases and asset_type:
        raise ValueError(f"Unsupported device type: {value}.")
    return aliases.get(value, "laptop")


def _replace_warranty(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    connection.execute("DELETE FROM warranty_records")
    for record in records:
        payload = dict(record)
        serial = _as_text(payload, "Serial number")
        normalized = _serial_key(serial)
        if not normalized:
            continue
        warranty_start = _normalize_inventory_date_field(payload, "Warranty Start Date", "warranty_start_date", "Warranty start date")
        warranty_end = _normalize_inventory_date_field(payload, "Warranty End Date", "warranty_end_date", "Warranty end date")
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
                warranty_start,
                warranty_end,
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_inventory(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in connection.execute("SELECT * FROM inventory_devices ORDER BY position, id"):
        payload = json.loads(row["data_json"])
        # Backward-compat normalization on read (does not persist until next write).
        payload = normalize_inventory_record_keys(payload)
        if row["purchase_date"]:
            payload["Purchase Date"] = row["purchase_date"]
        elif "Purchase Date" in payload:
            payload["Purchase Date"] = str(payload.get("Purchase Date") or "")
        if row["disposal_date"]:
            payload["Disposal Date"] = row["disposal_date"]
        elif "Disposal Date" in payload:
            payload["Disposal Date"] = str(payload.get("Disposal Date") or "")
        if row["warranty_start_date"]:
            payload["Warranty Start Date"] = row["warranty_start_date"]
        if row["warranty_end_date"]:
            payload["Warranty End Date"] = row["warranty_end_date"]
        # Ensure standardized Intune GroupName present from column
        if row["group_name"] or INTUNE_GROUP_NAME_KEY not in payload:
            payload[INTUNE_GROUP_NAME_KEY] = row["group_name"] or _as_text(payload, INTUNE_GROUP_NAME_KEY)
        records.append(payload)
    return records


def _read_warranty(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in connection.execute("SELECT * FROM warranty_records ORDER BY serial_number"):
        payload = json.loads(row["data_json"])
        if row["warranty_start_date"]:
            payload["Warranty Start Date"] = row["warranty_start_date"]
        if row["warranty_end_date"]:
            payload["Warranty End Date"] = row["warranty_end_date"]
        records.append(payload)
    return records


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
        event_date_raw = _as_text(record, "Event date").strip()
        staff_name = _as_text(record, "Staff name").strip()
        if not event_id or not asset_key or not event_date_raw or not staff_name:
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
        event_date = require_iso_date(event_date_raw, "Event date")
        if not event_date:
            raise ValueError("Event date: A valid date is required. Required format: YYYY-MM-DD (e.g. 2025-12-05).")
        parsed_date = datetime.strptime(event_date, "%Y-%m-%d").date()
        record["Event date"] = event_date
        expected_return_raw = _as_text(record, "Expected return date").strip()
        expected_return = require_iso_date(expected_return_raw, "Expected return date") if expected_return_raw else ""
        record["Expected return date"] = expected_return
        if expected_return:
            expected_date = datetime.strptime(expected_return, "%Y-%m-%d").date()
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


EXT_MARKER_RE = re.compile(r"(?:^|[^a-z0-9])ext([^a-z0-9]|$)", re.IGNORECASE)
PAREN_GROUP_RE = re.compile(r"\(([^()]*)\)")
VENDOR_SPLIT_RE = re.compile(r"[\s\-–—/]+")


def _detect_staff_type(name: str) -> tuple[str | None, str | None, bool]:
    """Detect Staff Type from a user Name.

    Returns (staff_type, vendor, suspicious):
      - staff_type is "External Staff", "Internal Staff", or None (unclassified).
      - vendor is the parsed vendor token (e.g. "FPT") or None.
      - suspicious flags names that contain an EXT marker outside parentheses.

    Defaults to Internal Staff when no EXT marker is present.
    """
    text = str(name or "").strip()
    if not text:
        return None, None, False
    paren = PAREN_GROUP_RE.search(text)
    if not paren:
        return STAFF_TYPE_INTERNAL, None, False
    group = paren.group(1)
    ext = EXT_MARKER_RE.search(group)
    if not ext:
        return STAFF_TYPE_INTERNAL, None, False
    after = group[ext.end():].split("[", 1)[0]
    vendor = VENDOR_SPLIT_RE.split(after.strip())[0].strip() or None
    outside = PAREN_GROUP_RE.sub("", text)
    suspicious = bool(EXT_MARKER_RE.search(outside))
    return STAFF_TYPE_EXTERNAL, vendor, suspicious


def _replace_users(connection: sqlite3.Connection, records: list[dict[str, Any]]) -> None:
    user_ids: set[str] = set()
    emails: set[str] = set()
    for record in records:
        user_id = _as_text(record, "UserID").strip()
        name = _as_text(record, "Name").strip()
        email = _as_text(record, "Email").strip()
        if not user_id:
            raise ValueError("Every user must include a User ID.")
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

    existing_staff: dict[str, tuple[str | None, str]] = {}
    for row in connection.execute("SELECT UserID, staff_type, staff_type_source FROM users"):
        existing_staff[str(row["UserID"] or "").strip()] = (
            str(row["staff_type"] or "").strip() or None,
            str(row["staff_type_source"] or "").strip() or STAFF_TYPE_SOURCE_AUTO,
        )

    connection.execute("DELETE FROM users")
    for position, record in enumerate(records):
        email = _as_text(record, "Email").strip()
        user_id = _as_text(record, "UserID").strip()
        name = _as_text(record, "Name").strip()
        existing_staff_type, existing_staff_source = existing_staff.get(user_id, (None, STAFF_TYPE_SOURCE_AUTO))
        incoming_staff_type_source = _as_text(record, "staff_type_source", "staffTypeSource") or STAFF_TYPE_SOURCE_AUTO
        explicit_recompute = bool(record.get("recompute_staff_type"))
        preserve_manual = (
            existing_staff_source == STAFF_TYPE_SOURCE_MANUAL
            and incoming_staff_type_source != STAFF_TYPE_SOURCE_MANUAL
            and not explicit_recompute
        )
        if preserve_manual:
            # A manual override is authoritative and must survive re-imports / re-detection.
            staff_type = existing_staff_type
            staff_type_source = STAFF_TYPE_SOURCE_MANUAL
        else:
            staff_type_source = incoming_staff_type_source
            staff_type_raw = record.get("staff_type", record.get("staffType"))
            staff_type = str(staff_type_raw).strip() if staff_type_raw is not None else ""
            staff_type = staff_type or None
            if staff_type_source == STAFF_TYPE_SOURCE_AUTO and (staff_type is None or explicit_recompute):
                staff_type, _vendor, _suspicious = _detect_staff_type(name)
                if explicit_recompute:
                    staff_type_source = STAFF_TYPE_SOURCE_AUTO
        payload = dict(record)
        payload.pop("staffType", None)
        payload.pop("staffTypeSource", None)
        payload["staff_type"] = staff_type
        payload["staff_type_source"] = staff_type_source
        connection.execute(
            """INSERT INTO users (UserID, position, name, email, normalized_email, staff_type, staff_type_source, data_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                _as_text(record, "UserID").strip(),
                position,
                _as_text(record, "Name").strip(),
                email,
                email.casefold(),
                staff_type,
                staff_type_source,
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            ),
        )


def _read_users(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT data_json, staff_type, staff_type_source FROM users ORDER BY position, UserID"
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        record = json.loads(row["data_json"])
        record["staff_type"] = row["staff_type"]
        record["staff_type_source"] = row["staff_type_source"]
        result.append(record)
    return result


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
            "SELECT UserID, name, email FROM users WHERE normalized_email=? COLLATE NOCASE LIMIT 1",
            (email.strip().casefold(),),
        ).fetchone()
    if not user_row and name:
        matches = connection.execute(
            "SELECT UserID, name, email FROM users WHERE name=? COLLATE NOCASE ORDER BY position LIMIT 2",
            (name.strip(),),
        ).fetchall()
        if len(matches) == 1:
            user_row = matches[0]
    if user_row:
        return {"id": user_row["UserID"], "name": user_row["name"], "email": user_row["email"]}
    return {"id": "", "name": name.strip(), "email": email.strip()}


ACTIVE_ASSIGNED_STATUS_NAMES = {"deployed", "in use", "active", "checked out", "assigned", "in service"}

DEFAULT_REPLACEMENT_HANDOFF_CONFIG = {
    "deployment_statuses": ["In Stock"],
    "conditions": ["Good"],
}


def _active_assigned_device(device: dict[str, Any], active_checkouts: set[str]) -> bool:
    serial = _asset_serial(device)
    status = _as_text(device, "Status Label", "Status").strip().casefold()
    assigned = bool(_as_text(device, "Primary user email address", "Primary user UPN", "Primary user display name"))
    active_checkout_keys = {_serial_key(value) for value in active_checkouts}
    return bool(serial and (_serial_key(serial) in active_checkout_keys
                            or status in ACTIVE_ASSIGNED_STATUS_NAMES
                            or (assigned and not status)))


def _read_replacement_handoff_config(connection: sqlite3.Connection) -> dict[str, list[str]]:
    row = connection.execute(
        "SELECT value FROM app_metadata WHERE key='replacement_handoff_config'"
    ).fetchone()
    if not row:
        return {"deployment_statuses": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"]),
                "conditions": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])}
    try:
        payload = json.loads(row["value"])
    except Exception:
        return {"deployment_statuses": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"]),
                "conditions": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])}
    if not isinstance(payload, dict):
        return {"deployment_statuses": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"]),
                "conditions": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])}
    dep = payload.get("deployment_statuses")
    cond = payload.get("conditions")
    dep_list = [str(v).strip() for v in dep] if isinstance(dep, list) else list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"])
    cond_list = [str(v).strip() for v in cond] if isinstance(cond, list) else list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])
    dep_list = [v for v in dep_list if v]
    cond_list = [v for v in cond_list if v]
    if not dep_list:
        dep_list = list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"])
    if not cond_list:
        cond_list = list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])
    return {"deployment_statuses": dep_list, "conditions": cond_list}


def _save_replacement_handoff_config(connection: sqlite3.Connection, payload: Any) -> dict[str, list[str]]:
    if not isinstance(payload, dict):
        raise ValueError("Replacement handoff config must be a JSON object.")
    dep = payload.get("deployment_statuses")
    cond = payload.get("conditions")
    if not isinstance(dep, list) or not isinstance(cond, list):
        raise ValueError("deployment_statuses and conditions must be arrays.")
    dep_list = [str(v).strip() for v in dep if str(v).strip()]
    cond_list = [str(v).strip() for v in cond if str(v).strip()]
    invalid_dep = [v for v in dep_list if v not in DEPLOYMENT_STATUS]
    if invalid_dep:
        raise ValueError(f"Unknown deployment status values: {', '.join(invalid_dep)}.")
    invalid_cond = [v for v in cond_list if v not in CONDITION]
    if invalid_cond:
        raise ValueError(f"Unknown condition values: {', '.join(invalid_cond)}.")
    if not dep_list or not cond_list:
        raise ValueError("Select at least one allowed deployment status and one allowed condition.")
    config = {"deployment_statuses": dep_list, "conditions": cond_list}
    connection.execute(
        "INSERT OR REPLACE INTO app_metadata(key, value) VALUES('replacement_handoff_config', ?)",
        (json.dumps(config, ensure_ascii=False),),
    )
    return config


def _format_condition_label(value: str) -> str:
    raw = str(value or "").strip()
    return CONDITION_LABELS.get(raw, raw)


def _asset_display_name(record: dict[str, Any]) -> str:
    serial = _as_text(record, "Serial number", "IntuneGroup.SerialNumber").strip() or "(no serial)"
    name = _as_text(record, "Device name").strip()
    return f"{name} ({serial})" if name else serial


def _replacement_handoff_eligibility(record: dict[str, Any], active_checkouts: set[str] | None = None, connection: sqlite3.Connection | None = None, config: dict[str, list[str]] | None = None) -> tuple[bool, str]:
    if config is None:
        if connection is not None:
            config = _read_replacement_handoff_config(connection)
        else:
            config = {"deployment_statuses": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"]),
                      "conditions": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])}
    serial = _asset_serial(record)
    if active_checkouts and serial in active_checkouts:
        return False, "it is currently checked out"
    if _as_text(record, "Primary user email address", "Primary user UPN", "Primary user display name"):
        return False, "it is assigned to a primary user"
    deployment_status = _as_text(record, "deployment_status").strip()
    condition = _as_text(record, "condition").strip()
    allowed_dep = config.get("deployment_statuses") or []
    allowed_cond = config.get("conditions") or []
    allowed_desc = [f"{ds} + {_format_condition_label(c)}" for ds in allowed_dep for c in allowed_cond]
    allowed_text = ", ".join(allowed_desc) if allowed_desc else "(none configured)"
    if not deployment_status:
        return False, f"Deployment Status is blank (allowed: {allowed_text})"
    if deployment_status not in allowed_dep:
        return False, f"Deployment Status is '{deployment_status}' and Condition is '{_format_condition_label(condition) or 'blank'}' (allowed: {allowed_text})"
    if not condition:
        return False, f"Deployment Status is '{deployment_status}' and Condition is blank (allowed: {allowed_text})"
    if condition not in allowed_cond:
        return False, f"Deployment Status is '{deployment_status}' and Condition is '{_format_condition_label(condition)}' (allowed: {allowed_text})"
    status = _as_text(record, "Status Label", "Status").strip()
    if status and status.casefold() in {n.casefold() for n in ACTIVE_ASSIGNED_STATUS_NAMES}:
        return False, f"Status Label is '{status}' (allowed: {allowed_text})"
    return True, ""


def _eligible_handout_device(record: dict[str, Any], active_checkouts: set[str] | None = None, connection: sqlite3.Connection | None = None, config: dict[str, list[str]] | None = None) -> bool:
    ok, _reason = _replacement_handoff_eligibility(record, active_checkouts, connection=connection, config=config)
    return ok


def _replacement_handoff_ineligible_error(record: dict[str, Any], active_checkouts: set[str] | None = None, connection: sqlite3.Connection | None = None, config: dict[str, list[str]] | None = None) -> str:
    ok, reason = _replacement_handoff_eligibility(record, active_checkouts, connection=connection, config=config)
    if ok:
        return ""
    name = _asset_display_name(record)
    deployment_status = _as_text(record, "deployment_status").strip() or "blank"
    condition = _format_condition_label(_as_text(record, "condition").strip()) or "blank"
    status_label = _as_text(record, "Status Label", "Status").strip() or "blank"
    if config is None and connection is not None:
        cfg = _read_replacement_handoff_config(connection)
    else:
        cfg = config or {"deployment_statuses": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["deployment_statuses"]),
                         "conditions": list(DEFAULT_REPLACEMENT_HANDOFF_CONFIG["conditions"])}
    allowed_desc = [f"{ds} + {_format_condition_label(c)}" for ds in (cfg.get("deployment_statuses") or []) for c in (cfg.get("conditions") or [])]
    allowed_text = ", ".join(allowed_desc) if allowed_desc else "(none configured)"
    return (
        f"Device '{name}' cannot be used as a replacement: {reason}. "
        f"Current status — Deployment Status: '{deployment_status}', Condition: '{condition}', Status Label: '{status_label}'. "
        f"Allowed for replacement handoff: {allowed_text}."
    )


def _assigned_device_status_label(connection: sqlite3.Connection) -> str:
    labels = _read_status_labels(connection)
    deployed = next((label["name"] for label in labels
                     if label["name"].casefold() == "deployed" and label["type"] == "Deployable"), None)
    if deployed:
        return deployed
    deployable = next((label["name"] for label in labels if label["type"] == "Deployable"), None)
    if not deployable:
        # Attempt self-heal to defaults so replacement can proceed
        try:
            _replace_status_labels(connection, list(DEFAULT_STATUS_LABELS))
            labels = _read_status_labels(connection)
            deployed = next((label["name"] for label in labels
                             if label["name"].casefold() == "deployed" and label["type"] == "Deployable"), None)
            if deployed:
                return deployed
            deployable = next((label["name"] for label in labels if label["type"] == "Deployable"), None)
            if deployable:
                return deployable
        except Exception:
            pass
        raise ValueError(
            "No Deployable Status Label is configured (required to assign the replacement device). "
            "Restore default status labels (including 'Deployed', type Deployable) in settings/data and try again."
        )
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
        handoff_config = _read_replacement_handoff_config(connection)
        ok, _ = _replacement_handoff_eligibility(target, active_checkouts, config=handoff_config)
        if not ok:
            raise ValueError(_replacement_handoff_ineligible_error(target, active_checkouts, config=handoff_config))
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
        "SELECT data_json FROM users WHERE UserID=? COLLATE NOCASE", (user_id,)
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
    replacement_date = require_iso_date(_as_text(record, "Replacement Date"), "Replacement Date")
    if not replacement_date:
        raise ValueError("Replacement Date: A valid date is required. Required format: YYYY-MM-DD (e.g. 2025-12-05).")
    record["Replacement Date"] = replacement_date

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

        outcome = _as_text(record, "old_device_outcome").strip()
        if outcome:
            if outcome not in OLD_DEVICE_OUTCOME:
                raise ValueError(f"Invalid old device outcome: {outcome}.")
            outcome_effects = {
                "Re-issued to another user": ("In Stock", None),
                "Sent to workshop for repair": ("Workshop", "Needs Repair"),
                "Awaiting re-imaging": ("Workshop", "Unknown"),
                "Retired pending disposal": ("Retired", "End of Life"),
                "Disposed": ("Disposed", "End of Life"),
            }
            new_status, new_condition = outcome_effects[outcome]
            old_device["deployment_status"] = new_status
            if new_condition is not None:
                old_device["condition"] = new_condition
            _validate_device_status(old_device)
            connection.execute("UPDATE inventory_devices SET data_json=? WHERE id=?",
                               (json.dumps(old_device, ensure_ascii=False, separators=(",", ":")), old_target["id"]))
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
        raise ValueError(f"Replacement device '{new_serial}' was not found in inventory. Refresh and choose another device.")
    target_record = json.loads(target["data_json"])
    is_same_existing_target = bool(old_target_serial and _serial_key(old_target_serial) == _serial_key(new_serial))
    active_checkouts = _active_checkout_serials(connection)
    handoff_config = _read_replacement_handoff_config(connection)
    if not is_same_existing_target:
        ok, _ = _replacement_handoff_eligibility(target_record, active_checkouts, config=handoff_config)
        if not ok:
            raise ValueError(_replacement_handoff_ineligible_error(target_record, active_checkouts, config=handoff_config))
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

    def _send_json(self, status: int, payload: dict[str, Any], extra_headers: list[tuple[str, str]] | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        for name, value in extra_headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)

    def _cookie_secure_flag(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def _session_cookie_header(self, session_id: str, *, clear: bool = False) -> str:
        parts = [f"{AUTH_SESSION_COOKIE}={'deleted' if clear else session_id}"]
        parts.append("Path=/")
        parts.append("HttpOnly")
        parts.append("SameSite=Lax")
        if self._cookie_secure_flag():
            parts.append("Secure")
        if clear:
            parts.append("Max-Age=0")
            parts.append("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        return "; ".join(parts)

    def _request_session_id(self) -> str:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(AUTH_SESSION_COOKIE)
        return morsel.value if morsel else ""

    def _get_authenticated_user(self, *, touch: bool = True) -> dict[str, Any] | None:
        session_id = self._request_session_id()
        if not session_id:
            return None
        try:
            with _DB_LOCK, database_connection() as connection:
                return _get_session_auth(connection, session_id, touch=touch)
        except (OSError, sqlite3.Error) as error:
            self.log_error("Session lookup failed: %s", error)
            return None

    def _require_auth(self, *, admin: bool = False, touch: bool = True) -> dict[str, Any] | None:
        auth = self._get_authenticated_user(touch=touch)
        if auth is None:
            self._send_json(401, {"error": "Authentication required."}, [("Set-Cookie", self._session_cookie_header("", clear=True))])
            return None
        if admin and (auth.get("user") or {}).get("role") != "admin":
            self._send_json(403, {"error": "Administrator access required."})
            return None
        return auth

    def _client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return self.client_address[0] if self.client_address else ""

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
        sql = ("SELECT UserID, name, email FROM users "
               "WHERE LOWER(name) LIKE LOWER(?) ESCAPE '\\' "
               "OR LOWER(email) LIKE LOWER(?) ESCAPE '\\' "
               "ORDER BY name COLLATE NOCASE, UserID LIMIT 40")
        rows = self._logged_search_rows("users", sql, (pattern, pattern))
        return [{"id": row["UserID"], "name": row["name"], "email": row["email"]} for row in rows]

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
            handoff_config = _read_replacement_handoff_config(connection)
        devices = []
        needle = query.casefold()
        for row in rows:
            device = json.loads(row["data_json"])
            serial = _asset_serial(device).strip()
            fields = [serial, _as_text(device, "Model"), _as_text(device, "Country"),
                      _as_text(device, "Fixed Asset Number"), _as_text(device, "Device name")]
            ok, _ = _replacement_handoff_eligibility(device, active_checkouts, config=handoff_config)
            if not serial or _serial_key(serial) in excluded or not ok:
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
                user_sql = "SELECT 1 FROM users WHERE UserID=? COLLATE NOCASE"
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
                fields = [serial, _as_text(device, "Device name"),
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

        if parsed.path == "/api/health":
            self._send_json(200, {
                "status": "ok",
                "database": str(DATABASE_PATH),
                "apiVersion": API_VERSION,
                "replacementAutocomplete": True,
            })
            return

        if parsed.path == "/api/auth/me":
            auth = self._get_authenticated_user(touch=True)
            if auth is None:
                self._send_json(401, {"authenticated": False, "error": "Authentication required."}, [("Set-Cookie", self._session_cookie_header("", clear=True))])
                return
            self._send_json(200, {"authenticated": True, "user": auth["user"]})
            return

        if parsed.path.startswith("/api/"):
            if self._require_auth(touch=True) is None:
                return

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
        if parsed.path == "/api/replacement-handoff-config":
            try:
                with _DB_LOCK, database_connection() as connection:
                    config = _read_replacement_handoff_config(connection)
                self._send_json(200, {
                    "config": config,
                    "defaults": DEFAULT_REPLACEMENT_HANDOFF_CONFIG,
                    "allowedDeploymentStatuses": list(DEPLOYMENT_STATUS),
                    "allowedConditions": [{"value": v, "label": CONDITION_LABELS.get(v, v)} for v in CONDITION],
                })
            except (OSError, sqlite3.Error) as error:
                self.log_error("Replacement handoff config query failed: %s", error)
                self._send_json(500, {"error": "Could not load replacement handoff configuration."})
            return
        if parsed.path == "/api/auth/users":
            if self._require_auth(admin=True, touch=False) is None:
                return
            try:
                with _DB_LOCK, database_connection() as connection:
                    rows = connection.execute(
                        "SELECT id, username, role, is_active, must_change_password, last_login_at, created_at, updated_at FROM auth_users ORDER BY username COLLATE NOCASE"
                    ).fetchall()
                self._send_json(200, {"users": [_public_auth_user(row) for row in rows]})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Auth user list failed: %s", error)
                self._send_json(500, {"error": "Could not load login users."})
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
                    users = _read_users(connection)
                options = filter_options(records, status_labels=status_labels, checkout_history=checkout_history)
                options["warrantyStatus"] = options.pop("warranty", [])
                options["plannedAction"] = options.pop("planned_action", [])
                options["assetStatus"] = options.pop("asset_status", [])
                options["onlineStatus"] = options.pop("online_status", [])

                def _country_raw(value: Any) -> str:
                    return str(value or "").strip()

                user_country_raws = []
                seen_user_country_keys = set()
                for user in users:
                    raw = _country_raw(user.get("Country"))
                    if not raw:
                        continue
                    key = " ".join(raw.casefold().split())
                    if key in seen_user_country_keys:
                        continue
                    seen_user_country_keys.add(key)
                    user_country_raws.append(raw)
                user_country_raws.sort(key=str.casefold)

                asset_country_info = []
                seen_asset_country_keys = set()
                no_country_asset_count = 0
                for record in records:
                    raw = _country_raw(record.get("Country"))
                    if not raw:
                        # fall back to same asset-country derivation used by dashboard metrics
                        raw = _country_raw(record.get("Intune_Group_APAC_Devices - Copy.Country"))
                    if not raw:
                        no_country_asset_count += 1
                        continue
                    key = " ".join(raw.casefold().split())
                    if key in seen_asset_country_keys:
                        continue
                    seen_asset_country_keys.add(key)
                    asset_country_info.append((key, raw))

                user_country_keys = set(seen_user_country_keys)
                asset_only_countries = sorted(
                    [raw for key, raw in asset_country_info if key not in user_country_keys],
                    key=str.casefold,
                )
                country_options = list(user_country_raws)
                for raw in asset_only_countries:
                    key = " ".join(raw.casefold().split())
                    if key not in user_country_keys:
                        country_options.append(raw)
                        user_country_keys.add(key)

                # Best-effort reporting for assets linked to users with no country (by primary user email).
                user_country_by_email = {}
                for user in users:
                    email = " ".join(str(user.get("Email") or "").strip().casefold().split())
                    if not email:
                        continue
                    user_country_by_email[email] = _country_raw(user.get("Country"))
                assets_linked_to_user_without_country = 0
                for record in records:
                    email = " ".join(str(record.get("Primary user email address") or record.get("Primary user UPN") or "").strip().casefold().split())
                    if not email or email not in user_country_by_email:
                        continue
                    if not user_country_by_email[email]:
                        assets_linked_to_user_without_country += 1

                if no_country_asset_count > 0 or assets_linked_to_user_without_country > 0:
                    # Explicit option to avoid silently dropping rows from view/filtering context.
                    if "(No country)" not in country_options:
                        country_options.append("(No country)")
                options["country"] = country_options

                self._send_json(200, {
                    "filterOptions": options,
                    "sourceRecordCount": len(records),
                    "replacementRecordCount": len(replacements),
                    "checkoutEventCount": len(checkout_history),
                    "countryFilterReport": {
                        "source": "users",
                        "userCountryCount": len(user_country_raws),
                        "userCountries": user_country_raws,
                        "assetOnlyCountryCount": len(asset_only_countries),
                        "assetOnlyCountries": asset_only_countries,
                        "noCountryAssetCount": no_country_asset_count,
                        "assetsLinkedToUserWithoutCountryCount": assets_linked_to_user_without_country,
                        "noCountryOptionIncluded": ("(No country)" in country_options),
                        "note": "Country options are derived from distinct user countries (trimmed, de-duped case-insensitively, sorted). Asset-only country values are appended so asset-country filtering still matches; '(No country)' is included when assets have no country value or are linked to a user with no country. Dashboard filtering/counts/charts continue to use asset country values."
                    },
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
        parsed = urlsplit(self.path)

        if parsed.path == "/api/auth/login":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Login payload must be a JSON object.")
                username = _normalize_username(payload.get("username"))
                password = str(payload.get("password") or "")
                if not username or not password:
                    raise ValueError("Username and password are required.")
                ip_address = self._client_ip()
                user_agent = self.headers.get("User-Agent", "")
                with _DB_LOCK, database_connection() as connection:
                    _check_login_rate_limit(connection, username, ip_address)
                    row = connection.execute(
                        "SELECT id, username, password_hash, role, is_active, must_change_password, last_login_at, created_at, updated_at FROM auth_users WHERE username=? COLLATE NOCASE",
                        (username,),
                    ).fetchone()
                    if row is None or not verify_password(password, row["password_hash"]) or not int(row["is_active"] or 0):
                        _record_login_failure(connection, username, ip_address)
                        self._send_json(401, {"error": "Invalid username or password."})
                        return
                    _clear_login_failures(connection, username, ip_address)
                    now_iso = _utc_now_iso()
                    connection.execute("UPDATE auth_users SET last_login_at=?, updated_at=? WHERE id=?", (now_iso, now_iso, row["id"]))
                    session_id = _create_session(connection, int(row["id"]), ip_address=ip_address, user_agent=user_agent)
                    user = _public_auth_user({**dict(row), "last_login_at": now_iso, "updated_at": now_iso})
                self._send_json(200, {"authenticated": True, "user": user}, [("Set-Cookie", self._session_cookie_header(session_id))])
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Login failed: %s", error)
                self._send_json(500, {"error": "Could not complete login."})
            return

        if parsed.path == "/api/auth/logout":
            session_id = self._request_session_id()
            try:
                if session_id:
                    with _DB_LOCK, database_connection() as connection:
                        connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL", (_utc_now_iso(), session_id))
            except (OSError, sqlite3.Error) as error:
                self.log_error("Logout failed: %s", error)
            self._send_json(200, {"authenticated": False}, [("Set-Cookie", self._session_cookie_header("", clear=True))])
            return

        if parsed.path.startswith("/api/"):
            auth = self._require_auth(touch=True)
            if auth is None:
                return

        admin_only_post_paths = {"/api/restore", "/api/clean-database", "/api/auth/users", "/api/auth/users/reset-password", "/api/auth/users/delete"}
        if parsed.path in admin_only_post_paths:
            if self._require_auth(admin=True, touch=False) is None:
                return

        if parsed.path == "/api/auth/users":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("User payload must be a JSON object.")
                username = _normalize_username(payload.get("username"))
                password = _validate_new_password(payload.get("password"))
                role = str(payload.get("role") or "").strip().lower()
                if role not in {"admin", "member"}:
                    raise ValueError("Role must be 'admin' or 'member'.")
                now_iso = _utc_now_iso()
                with _DB_LOCK, database_connection() as connection:
                    existing = connection.execute("SELECT 1 FROM auth_users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
                    if existing:
                        raise ValueError("Username already exists.")
                    connection.execute(
                        "INSERT INTO auth_users(username, password_hash, role, is_active, must_change_password, failed_login_count, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)",
                        (username, hash_password(password), role, now_iso, now_iso),
                    )
                    row = connection.execute(
                        "SELECT id, username, role, is_active, must_change_password, last_login_at, created_at, updated_at FROM auth_users WHERE username=? COLLATE NOCASE",
                        (username,),
                    ).fetchone()
                self._send_json(200, {"user": _public_auth_user(row)})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Auth user create failed: %s", error)
                self._send_json(500, {"error": "Could not create login user."})
            return

        if parsed.path == "/api/auth/users/reset-password":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Reset payload must be a JSON object.")
                user_id = int(payload.get("id") or 0)
                password = _validate_new_password(payload.get("password"))
                if user_id <= 0:
                    raise ValueError("A valid user id is required.")
                now_iso = _utc_now_iso()
                with _DB_LOCK, database_connection() as connection:
                    row = connection.execute("SELECT id FROM auth_users WHERE id=?", (user_id,)).fetchone()
                    if row is None:
                        self._send_json(404, {"error": "User not found."})
                        return
                    connection.execute(
                        "UPDATE auth_users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?",
                        (hash_password(password), now_iso, user_id),
                    )
                    # Revoke existing sessions for security after password reset.
                    connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now_iso, user_id))
                self._send_json(200, {"reset": True})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Auth user password reset failed: %s", error)
                self._send_json(500, {"error": "Could not reset password."})
            return

        if parsed.path == "/api/auth/users/delete":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Delete payload must be a JSON object.")
                user_id = int(payload.get("id") or 0)
                if user_id <= 0:
                    raise ValueError("A valid user id is required.")
                current_user_id = int((auth.get("user") or {}).get("id") or 0)
                if user_id == current_user_id:
                    raise ValueError("You cannot delete your own account.")
                now_iso = _utc_now_iso()
                with _DB_LOCK, database_connection() as connection:
                    row = connection.execute("SELECT id FROM auth_users WHERE id=?", (user_id,)).fetchone()
                    if row is None:
                        self._send_json(404, {"error": "User not found."})
                        return
                    # Soft delete for auditability.
                    connection.execute(
                        "UPDATE auth_users SET is_active=0, username=username || ? || ?, updated_at=? WHERE id=?",
                        ("__deleted__", str(user_id), now_iso, user_id),
                    )
                    connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now_iso, user_id))
                self._send_json(200, {"deleted": True})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Auth user delete failed: %s", error)
                self._send_json(500, {"error": "Could not delete user."})
            return

        if parsed.path == "/api/replacement-history/save":
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
        if parsed.path == "/api/restore":
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
        if parsed.path == "/api/clean-database":
            try:
                with _DB_LOCK, database_connection() as connection:
                    cleared = _clear_database(connection)
                self._send_json(200, {"cleared": cleared})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Database clear failed: %s", error)
                self._send_json(500, {"error": "Could not clear the SQLite database."})
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
        if self.path == "/api/field-options":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Field option save must include a JSON object.")
                field_name = payload.get("fieldName")
                value = payload.get("value")
                if not field_name or not value:
                    raise ValueError("fieldName and value are required.")
                with _DB_LOCK, database_connection() as connection:
                    connection.execute(
                        "INSERT OR IGNORE INTO asset_field_options(field_name, value, is_legacy, position) VALUES (?, ?, 0, 0)",
                        (field_name, value),
                    )
                    connection.commit()
                self._send_json(200, {"saved": True})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Field option save failed: %s", error)
                self._send_json(500, {"error": "Could not save field option."})
            return
        if self.path == "/api/replacement-handoff-config":
            if self._require_auth(admin=True, touch=False) is None:
                return
            try:
                payload = self._read_json()
                with _DB_LOCK, database_connection() as connection:
                    config = _save_replacement_handoff_config(connection, payload)
                self._send_json(200, {"saved": True, "config": config})
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Replacement handoff config save failed: %s", error)
                self._send_json(500, {"error": "Could not save replacement handoff configuration."})
            return
        if self.path == "/api/users/staff-type":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Staff type update must use a JSON object.")
                user_id = _as_text(payload, "UserID").strip() or _as_text(payload, "userId").strip()
                if not user_id:
                    raise ValueError("Staff type update requires a User ID.")
                raw_staff_type = payload.get("staffType", payload.get("staff_type"))
                if raw_staff_type is None:
                    staff_type = None
                else:
                    staff_type = str(raw_staff_type).strip()
                if staff_type == "":
                    staff_type = None
                if staff_type not in {None, "External Staff", "Internal Staff"}:
                    raise ValueError("Staff type must be External Staff, Internal Staff, or Unclassified.")
                with _DB_LOCK, database_connection() as connection:
                    row = connection.execute(
                        "SELECT UserID, data_json FROM users WHERE UserID=? COLLATE NOCASE",
                        (user_id,),
                    ).fetchone()
                    if row is None:
                        self._send_json(404, {"error": f"User not found: {user_id}"})
                        return
                    record = json.loads(row["data_json"])
                    record["staff_type"] = staff_type
                    record["staff_type_source"] = STAFF_TYPE_SOURCE_MANUAL
                    connection.execute(
                        "UPDATE users SET staff_type=?, staff_type_source=?, data_json=? WHERE UserID=? COLLATE NOCASE",
                        (staff_type, STAFF_TYPE_SOURCE_MANUAL, json.dumps(record, ensure_ascii=False, separators=(",", ":")), user_id),
                    )
                    connection.commit()
                self._send_json(200, {
                    "UserID": user_id,
                    "staffType": staff_type,
                    "staffTypeSource": STAFF_TYPE_SOURCE_MANUAL,
                })
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Staff type update failed: %s", error)
                self._send_json(500, {"error": "Could not save the user staff type."})
            return
        if self.path == "/api/users/staff-type/reset":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise ValueError("Staff type reset must use a JSON object.")
                user_id = _as_text(payload, "UserID").strip() or _as_text(payload, "userId").strip()
                if not user_id:
                    raise ValueError("Staff type reset requires a User ID.")
                with _DB_LOCK, database_connection() as connection:
                    row = connection.execute(
                        "SELECT UserID, name, data_json FROM users WHERE UserID=? COLLATE NOCASE",
                        (user_id,),
                    ).fetchone()
                    if row is None:
                        self._send_json(404, {"error": f"User not found: {user_id}"})
                        return
                    staff_type, _vendor, _suspicious = _detect_staff_type(row["name"])
                    record = json.loads(row["data_json"])
                    record["staff_type"] = staff_type
                    record["staff_type_source"] = STAFF_TYPE_SOURCE_AUTO
                    connection.execute(
                        "UPDATE users SET staff_type=?, staff_type_source=?, data_json=? WHERE UserID=? COLLATE NOCASE",
                        (staff_type, STAFF_TYPE_SOURCE_AUTO, json.dumps(record, ensure_ascii=False, separators=(",", ":")), user_id),
                    )
                    connection.commit()
                self._send_json(200, {
                    "UserID": user_id,
                    "staffType": staff_type,
                    "staffTypeSource": STAFF_TYPE_SOURCE_AUTO,
                })
            except ValueError as error:
                self._send_json(400, {"error": str(error)})
            except (OSError, sqlite3.Error) as error:
                self.log_error("Staff type reset failed: %s", error)
                self._send_json(500, {"error": "Could not reset the user staff type."})
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
        if self.path.startswith("/api/"):
            if self._require_auth(touch=True) is None:
                return
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
        return

    def log_message(self, format_string: str, *args: Any) -> None:
        super().log_message(format_string, *args)


def main() -> None:
    host = os.environ.get("NEXIT_HOST", "0.0.0.0")
    port = int(os.environ.get("NEXIT_PORT", "8000"))
    connect_database().close()
    server = ThreadingHTTPServer((host, port), InventoryRequestHandler)
    display_host = "localhost" if host in {"127.0.0.1", "localhost"} else host
    print(f"NexIT is running at http://{display_host}:{port} (bound to {host}:{port})")
    print(f"SQLite database: {DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping NexIT server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
