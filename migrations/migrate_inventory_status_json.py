#!/usr/bin/env python3
"""Hydrate normalized deployment and condition fields in inventory_devices.data_json.

Preview the migration with:
  python3 migrations/migrate_inventory_status_json.py --dry-run --log /tmp/migration_log.json

Apply it to the active NexIT database with:
  python3 migrations/migrate_inventory_status_json.py --apply

The apply mode creates a SQLite backup before changing records. Each run writes
one migration_log.json entry per inventory row. Existing deployment_status
values are left untouched and recorded with action="skipped".
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from contextlib import closing
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


DEPLOYMENT_STATUSES = {"In Use", "In Stock", "Workshop", "Retired", "Disposed"}
CONDITIONS = {"Good", "Needs Repair", "End of Life", "Unknown"}
EXPECTED_ROWS = 1161
MIGRATION_NAME = "inventory_status_json_v1"
LABEL_KEYS = ("Status Label", "status", "Status", "lifecycle_status", "Lifecycle Status")
EMAIL_KEYS = (
    "Primary user email address", "Primary user UPN", "primary_user_email",
    "primary_user_upn", "user_email",
)
CHECKIN_KEYS = ("Last check-in", "Last Check-In", "Last Check In", "last_check_in")
KNOWN_LABELS = {
    "deployed", "in use", "available for handover", "ready to deploy", "in stock",
    "awaiting reimaging", "awaiting re-imaging", "reimaging", "pending assessment",
    "pending", "in repair", "undeployable", "decommissioned",
    "decommissioned archived", "disposed", "disposed archive", "archived",
    "retired", "recycle", "dispose", "workshop",
}

QA_QUERY = """SELECT
  json_extract(data_json, '$.deployment_status') AS deployment_status,
  json_extract(data_json, '$.condition') AS condition,
  json_extract(data_json, '$.is_archived') AS is_archived,
  COUNT(*) AS n
FROM inventory_devices
GROUP BY 1, 2, 3
ORDER BY n DESC;"""


def default_database_path() -> Path:
    if os.name == "nt":
        data_root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        data_root = Path.home() / "Library" / "Application Support"
    else:
        data_root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return data_root / "NexIT-Asset-Inventory" / "nexit-assets.db"


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize(value: str) -> str:
    return " ".join(value.casefold().replace("_", " ").replace("-", " ").split())


def _source_labels(record: dict[str, Any]) -> list[tuple[str, str]]:
    return [(key, _text(record.get(key))) for key in LABEL_KEYS if _text(record.get(key))]


def _unmapped_labels(labels: list[tuple[str, str]]) -> list[tuple[str, str]]:
    return [(key, value) for key, value in labels if _normalize(value) not in KNOWN_LABELS]


def _match_label(labels: list[tuple[str, str]], kind: str) -> tuple[str, str] | None:
    for key, value in labels:
        normalized = _normalize(value)
        if kind == "archived_or_disposed":
            if any(token in normalized for token in ("disposed", "dispose", "decommission", "retired", "recycle", "archived", "archive")):
                return key, value
        elif kind == "repair_or_undeployable":
            if any(token in normalized for token in ("undeployable", "repair", "broken", "damaged")):
                return key, value
        elif kind == "reimaging":
            if any(token in normalized for token in ("reimag", "pending assessment")):
                return key, value
    return None


def _status_fields(record: dict[str, Any]) -> tuple[str, str, bool, str, str]:
    """Return deployment, condition, archived, source_signal, matched_rule."""
    labels = _source_labels(record)
    archive = _match_label(labels, "archived_or_disposed")
    if archive:
        label_key, label = archive
        normalized = _normalize(label)
        disposed = any(token in normalized for token in ("disposed", "dispose"))
        if disposed:
            return "Disposed", "End of Life", True, f"{label_key}={label}", "disposed_label"
        return "Retired", "End of Life", True, f"{label_key}={label}", "retired_or_archived_label"

    repair = _match_label(labels, "repair_or_undeployable")
    if repair:
        label_key, label = repair
        return "Workshop", "Needs Repair", False, f"{label_key}={label}", "repair_or_undeployable_label"

    reimaging = _match_label(labels, "reimaging")
    if reimaging:
        label_key, label = reimaging
        return "Workshop", "Unknown", False, f"{label_key}={label}", "reimaging_or_assessment_label"

    email_key = next((key for key in EMAIL_KEYS if _text(record.get(key))), None)
    email = _text(record.get(email_key)) if email_key else ""
    if not email_key:
        email_key = next((key for key in EMAIL_KEYS if key in record), None)
    if email:
        last_checkin = next((_text(record.get(key)) for key in CHECKIN_KEYS if _text(record.get(key))), "")
        checkin_date = parse_checkin_date(last_checkin)
        if checkin_date is None:
            return "In Use", "Unknown", False, f"{email_key or 'primary_user_email'}=present", "assigned_checkin_missing_or_unparseable"
        age_days = (date.today() - checkin_date).days
        if 0 <= age_days <= 90:
            return "In Use", "Good", False, f"{email_key or 'primary_user_email'}=present", "assigned_checkin_within_90_days"
        return "In Use", "Unknown", False, f"{email_key or 'primary_user_email'}=present", "assigned_checkin_older_than_90_days_or_future"

    if email_key is not None:
        return "In Stock", "Good", False, f"{email_key}=empty", "unassigned_without_repair_or_imaging_flag"

    return "In Stock", "Unknown", False, "no_usable_source_signal", "no_signal_default"


def parse_checkin_date(value: str) -> date | None:
    text = value.strip()
    if not text:
        return None
    iso = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(iso).date()
    except ValueError:
        pass
    for pattern in (
        "%d-%m-%y %H:%M", "%d-%m-%Y %H:%M", "%d-%m-%y", "%d-%m-%Y",
        "%d-%b-%Y", "%d-%b-%y", "%d/%m/%Y", "%d/%m/%y", "%Y/%m/%d",
    ):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _get_log_identity(row: sqlite3.Row, record: dict[str, Any]) -> tuple[str, str]:
    serial = _text(record.get("Serial number") or record.get("IntuneGroup.SerialNumber") or row["serial_number"])
    device_name = _text(record.get("Device name") or row["device_name"])
    return serial, device_name


def _log_entry(row: sqlite3.Row, record: dict[str, Any], action: str) -> dict[str, Any]:
    serial, device_name = _get_log_identity(row, record)
    deployment = _text(record.get("deployment_status"))
    condition = _text(record.get("condition"))
    archived = record.get("is_archived")
    source_signal = "existing deployment_status"
    matched_rule = "already_migrated"
    if action in {"would_migrate", "migrated", "skipped"}:
        deployment, condition, archived, source_signal, matched_rule = _status_fields(record)
    if action == "skipped":
        deployment = _text(record.get("deployment_status"))
        condition = _text(record.get("condition"))
        archived = record.get("is_archived")
        matched_rule = "skipped_existing_deployment_status"
    return {
        "serial_number": serial,
        "device_name": device_name,
        "source_signal": source_signal,
        "matched_rule": matched_rule,
        "deployment_status": deployment or None,
        "condition": condition or None,
        "is_archived": archived,
        "action": action,
    }


def _log_unmapped(connection: sqlite3.Connection, row_id: int, serial: str, key: str, value: str) -> None:
    connection.execute(
        """INSERT INTO migration_errors
           (migration_name, inventory_id, serial_number, field_name, field_value, error, logged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(migration_name, inventory_id, field_name, field_value)
           DO UPDATE SET error=excluded.error, logged_at=excluded.logged_at""",
        (MIGRATION_NAME, row_id, serial, key, value, "Unmapped legacy status value; assignment/default rule used.",
         datetime.now(timezone.utc).isoformat()),
    )


def _write_log(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _validate_entries(entries: list[dict[str, Any]], total: int, expected_rows: int) -> list[str]:
    failures: list[str] = []
    serials_by_failure: list[str] = []
    if total != expected_rows:
        failures.append(f"total rows={total}; expected {expected_rows}")
        serials_by_failure.extend(entry["serial_number"] or "<missing serial>" for entry in entries)
    for entry in entries:
        serial = entry["serial_number"] or "<missing serial>"
        deployment = entry["deployment_status"]
        condition = entry["condition"]
        archived = entry["is_archived"]
        if deployment not in DEPLOYMENT_STATUSES or condition not in CONDITIONS or not isinstance(archived, bool):
            failures.append(f"NULL/illegal normalized field for serial {serial}")
            serials_by_failure.append(serial)
        if deployment == "Disposed" and condition == "Good":
            failures.append(f"illegal Disposed + Good combination for serial {serial}")
            serials_by_failure.append(serial)
    if failures:
        print("Migration assertion failures:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print("Offending serial numbers:", file=sys.stderr)
        for serial in sorted(set(serials_by_failure)):
            print(f"  - {serial}", file=sys.stderr)
    return failures


def migrate(database_path: Path, log_path: Path, backup_path: Path | None, apply: bool,
            expected_rows: int) -> int:
    if not database_path.exists():
        print(f"Database not found: {database_path}", file=sys.stderr)
        return 2
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "inventory_devices" not in tables:
            print("Expected NexIT table inventory_devices was not found.", file=sys.stderr)
            return 2
        rows = connection.execute("SELECT id, serial_number, device_name, data_json FROM inventory_devices ORDER BY position, id").fetchall()
        total = len(rows)
        if total != expected_rows:
            print(f"Row-count assertion failed: total rows={total}; expected {expected_rows}.", file=sys.stderr)
            print("Offending serial numbers (all rows in this database):", file=sys.stderr)
            for row in rows:
                print(f"  - {_text(row['serial_number']) or '<missing serial>'}", file=sys.stderr)
            return 1

        plans: list[tuple[sqlite3.Row, dict[str, Any], str, list[tuple[str, str]]]] = []
        entries: list[dict[str, Any]] = []
        unmapped_count = 0
        for row in rows:
            try:
                record = json.loads(row["data_json"])
            except (TypeError, json.JSONDecodeError) as error:
                print(f"Invalid data_json for serial {_text(row['serial_number']) or '<missing serial>'}: {error}", file=sys.stderr)
                return 1
            if not isinstance(record, dict):
                print(f"Non-object data_json for serial {_text(row['serial_number']) or '<missing serial>'}.", file=sys.stderr)
                return 1
            serial, _ = _get_log_identity(row, record)
            unmapped = _unmapped_labels(_source_labels(record))
            unmapped_count += len(unmapped)
            if _text(record.get("deployment_status")):
                action = "skipped"
                entries.append(_log_entry(row, record, action))
                plans.append((row, record, action, unmapped))
                continue
            deployment, condition, archived, _, _ = _status_fields(record)
            updated = {**record,
                       "deployment_status": deployment,
                       "condition": condition,
                       "is_archived": archived}
            action = "migrated" if apply else "would_migrate"
            entries.append(_log_entry(row, updated, action))
            plans.append((row, updated, action, unmapped))

        failures = _validate_entries(entries, total, expected_rows)
        if failures:
            _write_log(log_path, entries)
            return 1

        if apply:
            if backup_path is None:
                timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                backup_path = database_path.with_name(f"{database_path.stem}.before-status-migration-{timestamp}.db")
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(backup_path)) as backup:
                connection.backup(backup)
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("""CREATE TABLE IF NOT EXISTS migration_errors (
                    migration_name TEXT NOT NULL,
                    inventory_id INTEGER NOT NULL,
                    serial_number TEXT NOT NULL DEFAULT '',
                    field_name TEXT NOT NULL,
                    field_value TEXT NOT NULL,
                    error TEXT NOT NULL,
                    logged_at TEXT NOT NULL,
                    UNIQUE(migration_name, inventory_id, field_name, field_value)
                )""")
                for row, updated, action, unmapped in plans:
                    serial, _ = _get_log_identity(row, updated)
                    for key, value in unmapped:
                        _log_unmapped(connection, row["id"], serial, key, value)
                    if action != "migrated":
                        continue
                    connection.execute(
                        "UPDATE inventory_devices SET data_json=? WHERE id=?",
                        (json.dumps(updated, ensure_ascii=False, separators=(",", ":")), row["id"]),
                    )
                persisted = connection.execute("SELECT id, serial_number, data_json FROM inventory_devices ORDER BY position, id").fetchall()
                persisted_entries = []
                for row in persisted:
                    record = json.loads(row["data_json"])
                    serial = _text(record.get("Serial number") or record.get("IntuneGroup.SerialNumber") or row["serial_number"])
                    persisted_entries.append({
                        "serial_number": serial,
                        "deployment_status": record.get("deployment_status"),
                        "condition": record.get("condition"),
                        "is_archived": record.get("is_archived"),
                    })
                persisted_failures = []
                persisted_serials = []
                for entry in persisted_entries:
                    serial = entry["serial_number"] or "<missing serial>"
                    if (entry["deployment_status"] not in DEPLOYMENT_STATUSES
                            or entry["condition"] not in CONDITIONS
                            or not isinstance(entry["is_archived"], bool)):
                        persisted_failures.append(f"NULL/illegal normalized field for serial {serial}")
                        persisted_serials.append(serial)
                    if entry["deployment_status"] == "Disposed" and entry["condition"] == "Good":
                        persisted_failures.append(f"illegal Disposed + Good combination for serial {serial}")
                        persisted_serials.append(serial)
                if persisted_failures:
                    print("Post-migration assertion failures:", file=sys.stderr)
                    for failure in persisted_failures:
                        print(f"  - {failure}", file=sys.stderr)
                    print("Offending serial numbers:", file=sys.stderr)
                    for serial in sorted(set(persisted_serials)):
                        print(f"  - {serial}", file=sys.stderr)
                    connection.rollback()
                    for entry in entries:
                        if entry["action"] == "migrated":
                            entry["action"] = "rolled_back"
                    _write_log(log_path, entries)
                    return 1
                _write_log(log_path, entries)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        else:
            _write_log(log_path, entries)

        counts = Counter((entry["deployment_status"], entry["condition"], entry["is_archived"]) for entry in entries)
        print(f"Rows: {total}; {'migrated' if apply else 'would migrate'}: {sum(entry['action'] in {'migrated', 'would_migrate'} for entry in entries)}; skipped: {sum(entry['action'] == 'skipped' for entry in entries)}")
        print(f"Unmapped legacy label values logged: {unmapped_count}")
        print(f"Migration log: {log_path}")
        if apply:
            print(f"Database backup: {backup_path}")
        print("QA buckets (deployment_status, condition, is_archived, n):")
        for (deployment, condition, archived), count in counts.most_common():
            print(f"  {deployment}, {condition}, {int(bool(archived))}, {count}")
        print("QA query:")
        print(QA_QUERY)
        print("Assertions passed: total rows, non-NULL/legal enums, and no Disposed + Good records.")
        return 0
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=default_database_path(), help="NexIT SQLite database (defaults to the active app database)")
    parser.add_argument("--log", type=Path, default=None, help="migration_log.json output path (default: next to the database)")
    parser.add_argument("--backup", type=Path, default=None, help="backup path for --apply (default: timestamped file next to the database)")
    parser.add_argument("--expected-rows", type=int, default=EXPECTED_ROWS, help=f"expected inventory row count (default: {EXPECTED_ROWS})")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write normalized JSON fields; otherwise run a dry run")
    mode.add_argument("--dry-run", action="store_true", help="preview changes without modifying SQLite (default)")
    args = parser.parse_args()
    log_path = args.log or args.database.parent / "migration_log.json"
    return migrate(args.database, log_path, args.backup, args.apply, args.expected_rows)


if __name__ == "__main__":
    raise SystemExit(main())
