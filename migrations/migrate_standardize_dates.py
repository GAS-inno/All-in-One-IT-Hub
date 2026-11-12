#!/usr/bin/env python3
"""One-time migration: standardize date values in NexIT SQLite database.

- Converts Excel serial date values to ISO YYYY-MM-DD (1899-12-30 epoch).
- Replaces placeholder values ("not found", "null", etc.) with NULL/blank.
- Reports affected row/value counts before applying changes.

Usage:
  python3 migrations/migrate_standardize_dates.py --dry-run
  python3 migrations/migrate_standardize_dates.py --apply

The migration is idempotent and creates a DB backup before applying.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from date_utils import excel_serial_to_iso, is_placeholder_date, parse_date_to_iso  # noqa: E402


def _default_db_path() -> Path:
    if os.name == "nt":
        data_root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        data_root = Path.home() / "Library" / "Application Support"
    else:
        data_root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return data_root / "NexIT-Asset-Inventory" / "nexit-assets.db"


DATE_COLUMNS = {
    "inventory_devices": ["purchase_date", "warranty_start_date", "warranty_end_date", "disposal_date"],
    "warranty_records": ["warranty_start_date", "warranty_end_date"],
}
JSON_DATE_KEYS = {
    "inventory_devices": ["Purchase Date", "Warranty Start Date", "Warranty End Date", "Disposal Date", "Last check-in", "Enrollment date", "Enrollment Date", "Battery replacement date"],
    "warranty_records": ["Purchase Date", "Warranty Start Date", "Warranty End Date", "Disposal Date"],
    "checkout_history": ["Event date", "Expected return date"],
    "replacement_history": ["Replacement Date", "Handover Date"],
}


def _classify(value):
    text = str(value or "").strip()
    if text == "":
        return None
    if is_placeholder_date(text):
        return "placeholder"
    if excel_serial_to_iso(text):
        iso, err = parse_date_to_iso(text, strict=True)
        if iso and not err:
            return "excel_serial"
    return None


def _clean_value(value):
    text = str(value or "").strip()
    if not text:
        return value, False, None
    if is_placeholder_date(text):
        return ("" if value != "" else value), True, "placeholder"
    iso = excel_serial_to_iso(text)
    if iso:
        parsed_iso, err = parse_date_to_iso(text, strict=True)
        if parsed_iso and not err:
            return parsed_iso, (parsed_iso != value), "excel_serial"
    return value, False, None


def scan(connection: sqlite3.Connection):
    report = {"tables": {}, "totals": Counter()}
    for table, columns in DATE_COLUMNS.items():
        table_report = {"columns": {}, "json_keys": {}}
        for col in columns:
            try:
                rows = connection.execute(f"SELECT {col} AS v FROM {table}").fetchall()
            except sqlite3.Error:
                continue
            counts = Counter()
            samples = defaultdict(list)
            for row in rows:
                kind = _classify(row["v"])
                if kind:
                    counts[kind] += 1
                    if len(samples[kind]) < 5:
                        samples[kind].append(str(row["v"]))
                    report["totals"][kind] += 1
            if counts:
                table_report["columns"][col] = {"counts": dict(counts), "samples": dict(samples)}
        if table in JSON_DATE_KEYS:
            for key in JSON_DATE_KEYS[table]:
                try:
                    rows = connection.execute(f"SELECT data_json FROM {table}").fetchall()
                except sqlite3.Error:
                    continue
                counts = Counter()
                samples = defaultdict(list)
                for row in rows:
                    try:
                        data = json.loads(row["data_json"])
                    except Exception:
                        continue
                    if key not in data:
                        continue
                    kind = _classify(data.get(key))
                    if kind:
                        counts[kind] += 1
                        if len(samples[kind]) < 5:
                            samples[kind].append(str(data.get(key)))
                        report["totals"][kind] += 1
                if counts:
                    table_report["json_keys"][key] = {"counts": dict(counts), "samples": dict(samples)}
        if table_report["columns"] or table_report["json_keys"]:
            report["tables"][table] = table_report
    # JSON-only tables
    for table, keys in JSON_DATE_KEYS.items():
        if table in DATE_COLUMNS:
            continue
        try:
            rows = connection.execute(f"SELECT data_json FROM {table}").fetchall()
        except sqlite3.Error:
            continue
        table_report = {"columns": {}, "json_keys": {}}
        for key in keys:
            counts = Counter()
            samples = defaultdict(list)
            for row in rows:
                try:
                    data = json.loads(row["data_json"])
                except Exception:
                    continue
                if key not in data:
                    continue
                kind = _classify(data.get(key))
                if kind:
                    counts[kind] += 1
                    if len(samples[kind]) < 5:
                        samples[kind].append(str(data.get(key)))
                    report["totals"][kind] += 1
            if counts:
                table_report["json_keys"][key] = {"counts": dict(counts), "samples": dict(samples)}
        if table_report["json_keys"]:
            report["tables"][table] = table_report
    report["totals"] = dict(report["totals"])
    return report


def apply(connection: sqlite3.Connection):
    changes = Counter()
    # Column-backed tables
    for table, columns in DATE_COLUMNS.items():
        pk = "id" if table == "inventory_devices" else "normalized_serial"
        select_cols = [pk] + columns + ["data_json"]
        try:
            rows = connection.execute(f"SELECT {', '.join(select_cols)} FROM {table}").fetchall()
        except sqlite3.Error:
            continue
        for row in rows:
            updates = {}
            for col in columns:
                new_value, changed, kind = _clean_value(row[col])
                if changed:
                    # Store blank for placeholders (columns may be NOT NULL), ISO for excel serials.
                    updates[col] = "" if (kind == "placeholder" and str(new_value).strip() == "") else new_value
                    changes[f"{table}.{col}.{kind}"] += 1
            # data_json keys
            json_changed = False
            try:
                data = json.loads(row["data_json"])
            except Exception:
                data = None
            if isinstance(data, dict):
                for key in JSON_DATE_KEYS.get(table, []):
                    if key not in data:
                        continue
                    new_value, changed, kind = _clean_value(data.get(key))
                    if changed:
                        data[key] = "" if kind == "placeholder" else new_value
                        json_changed = True
                        changes[f"{table}.data_json[{key}].{kind}"] += 1
            if updates or json_changed:
                sets = []
                params = []
                for col, val in updates.items():
                    sets.append(f"{col}=?")
                    params.append(val)
                if json_changed:
                    sets.append("data_json=?")
                    params.append(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                params.append(row[pk])
                connection.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE {pk}=?", params)

    # JSON-only tables
    for table, keys in JSON_DATE_KEYS.items():
        if table in DATE_COLUMNS:
            continue
        pk = "event_id" if table == "checkout_history" else "replacement_id" if table == "replacement_history" else None
        if not pk:
            continue
        try:
            rows = connection.execute(f"SELECT {pk}, data_json FROM {table}").fetchall()
        except sqlite3.Error:
            continue
        for row in rows:
            try:
                data = json.loads(row["data_json"])
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            json_changed = False
            for key in keys:
                if key not in data:
                    continue
                new_value, changed, kind = _clean_value(data.get(key))
                if changed:
                    data[key] = "" if kind == "placeholder" else new_value
                    json_changed = True
                    changes[f"{table}.data_json[{key}].{kind}"] += 1
            if json_changed:
                connection.execute(
                    f"UPDATE {table} SET data_json=? WHERE {pk}=?",
                    (json.dumps(data, ensure_ascii=False, separators=(",", ":")), row[pk]),
                )
    return dict(changes)


def main() -> int:
    parser = argparse.ArgumentParser(description="Standardize NexIT date values (placeholders/Excel serials).")
    parser.add_argument("--db", help="Path to nexIT SQLite database")
    parser.add_argument("--dry-run", action="store_true", help="Report affected values without modifying the database")
    parser.add_argument("--apply", action="store_true", help="Apply fixes (creates a backup first)")
    args = parser.parse_args()

    if args.dry_run == args.apply:
        print("Specify exactly one of --dry-run or --apply.", file=sys.stderr)
        return 2

    db_path = Path(args.db).expanduser() if args.db else _default_db_path()
    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 1

    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    try:
        report = scan(connection)
        print(json.dumps({"database": str(db_path), "scan": report}, indent=2, ensure_ascii=False))
        if args.apply:
            backup_path = db_path.with_suffix(db_path.suffix + f".before-date-standardization-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
            connection.close()
            shutil.copy2(db_path, backup_path)
            print(f"Backup created: {backup_path}")
            connection = sqlite3.connect(str(db_path))
            connection.row_factory = sqlite3.Row
            with connection:
                changes = apply(connection)
            print(json.dumps({"applied": changes}, indent=2, ensure_ascii=False))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
