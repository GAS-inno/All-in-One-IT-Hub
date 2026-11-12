#!/usr/bin/env python3
"""Normalize all date values to YYYY-MM-DD (ISO 8601).

This migration is idempotent and safe to re-run.
- Scans known date columns and JSON date keys for placeholders/sentinels and Excel serials.
- Reports counts BEFORE changing anything.
- With --apply, creates a backup and normalizes offending values:
  - "not found", "null", empty/whitespace, sentinel 00-Jan-1900 -> NULL/blank
  - Excel serials -> YYYY-MM-DD (1899-12-30 epoch)
  - Existing parseable date strings -> YYYY-MM-DD (where applicable)
Non-date/unparseable values are left unchanged and reported.

Usage:
  python3 migrations/migrate_dates_to_yyyy_mm_dd.py --dry-run
  python3 migrations/migrate_dates_to_yyyy_mm_dd.py --apply
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from date_utils import excel_serial_to_iso, is_placeholder_date, parse_date_to_iso  # noqa: E402

try:
    from server import get_db_path
except Exception:  # pragma: no cover
    get_db_path = None

SENTINELS = {"00-jan-1900", "0-jan-1900", "1900-01-00"}

COLUMN_TARGETS = {
    "inventory_devices": [
        ("purchase_date", True),
        ("warranty_start_date", False),
        ("warranty_end_date", False),
        ("disposal_date", True),
    ],
    "warranty_records": [
        ("warranty_start_date", False),
        ("warranty_end_date", False),
    ],
}

JSON_TARGETS = {
    "inventory_devices": [
        "Purchase Date", "Warranty Start Date", "Warranty End Date", "Disposal Date",
        "Last check-in", "Last Check-In", "Last checkin", "LastSyncDateTime",
        "Enrollment date", "Enrollment Date", "Battery replacement date",
        "Event date", "Expected return date",
    ],
    "warranty_records": [
        "Purchase Date", "Warranty Start Date", "Warranty End Date", "Disposal Date",
        "Last check-in", "Enrollment date", "Enrollment Date",
    ],
    "checkout_history": ["Event date", "Expected return date"],
    "replacement_history": ["Replacement Date", "Handover Date"],
}


def _db_path(cli: str | None) -> Path:
    if cli:
        return Path(cli).expanduser().resolve()
    if get_db_path:
        return Path(get_db_path())
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "NexIT-Asset-Inventory" / "nexit-assets.db"


def _is_excel_serial(value: Any) -> bool:
    text = str(value or "").strip()
    if not text or not re.fullmatch(r"\d+(?:\.0+)?", text):
        return False
    try:
        n = float(text)
    except ValueError:
        return False
    return 0 < n <= 2958465


def _normalize_value(value: Any) -> tuple[str | None, str]:
    """Return (normalized_or_None_for_remove, reason). reason in {placeholder,sentinel,excel_serial,iso,unchanged,unparseable}."""
    raw = str(value if value is not None else "").strip()
    if raw == "":
        return "", "unchanged_empty"
    cf = raw.casefold()
    if cf in {"not found", "null"} or is_placeholder_date(raw):
        # treat all placeholders/sentinels as empty
        if cf in SENTINELS or cf in {"00-jan-1900", "0-jan-1900"}:
            return "", "sentinel"
        if cf in {"not found", "null"}:
            return "", "notfound_null"
        # other placeholders (none/n/a/unknown/-) treated as placeholder cleanup
        return "", "placeholder"
    if cf in SENTINELS:
        return "", "sentinel"
    if _is_excel_serial(raw):
        iso = excel_serial_to_iso(raw)
        if iso:
            return iso, "excel_serial"
    # If already ISO, keep
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        iso, err = parse_date_to_iso(raw, strict=False, allow_excel=False)
        return (iso if iso and not err else raw), "iso"
    # Try permissive parse for legacy stored display values during migration
    iso, err = parse_date_to_iso(raw, strict=False, allow_excel=True)
    if iso and not err:
        return iso, "normalized"
    return None, "unparseable"


@dataclass
class Report:
    notfound_null: int = 0
    excel_serial: int = 0
    sentinel_00_jan_1900: int = 0
    placeholders_other: int = 0
    normalized_legacy: int = 0
    unparseable: int = 0
    details: list[str] = field(default_factory=list)

    def add(self, loc: str, reason: str, before: Any, after: str | None = None):
        if reason == "notfound_null":
            self.notfound_null += 1
        elif reason == "excel_serial":
            self.excel_serial += 1
        elif reason == "sentinel":
            self.sentinel_00_jan_1900 += 1
        elif reason == "placeholder":
            self.placeholders_other += 1
        elif reason == "normalized":
            self.normalized_legacy += 1
        elif reason == "unparseable":
            self.unparseable += 1
        if reason in {"notfound_null", "excel_serial", "sentinel", "placeholder", "normalized", "unparseable"}:
            self.details.append(f"{loc}: {reason} '{before}' -> '{after}'")


def scan_and_apply(conn: sqlite3.Connection, apply: bool) -> Report:
    report = Report()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Column targets
    for table, cols in COLUMN_TARGETS.items():
        try:
            cur.execute(f"PRAGMA table_info({table})")
            existing = {r[1] for r in cur.fetchall()}
        except sqlite3.Error:
            continue
        for col, nullable in cols:
            if col not in existing:
                continue
            rows = cur.execute(f"SELECT rowid, {col} AS v FROM {table}").fetchall()
            for row in rows:
                before = row["v"]
                after, reason = _normalize_value(before)
                if reason in {"unchanged_empty", "iso"}:
                    continue
                report.add(f"{table}.{col}[rowid={row['rowid']}]", reason, before, after)
                if apply and after is not None and reason != "unparseable":
                    cur.execute(f"UPDATE {table} SET {col}=? WHERE rowid=?", (after if after != "" or not nullable else None, row["rowid"]))
                    # For NOT NULL text cols, store empty string instead of NULL
                    if not nullable and (after == "" or after is None):
                        cur.execute(f"UPDATE {table} SET {col}=? WHERE rowid=?", ("", row["rowid"]))

    # JSON targets
    for table, keys in JSON_TARGETS.items():
        try:
            rows = cur.execute(f"SELECT rowid, data_json FROM {table}").fetchall()
        except sqlite3.Error:
            continue
        for row in rows:
            try:
                data = json.loads(row["data_json"])
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            changed = False
            for key in keys:
                if key not in data:
                    continue
                before = data.get(key)
                after, reason = _normalize_value(before)
                if reason in {"unchanged_empty", "iso"}:
                    continue
                report.add(f"{table}.data_json[{key}][rowid={row['rowid']}]", reason, before, after)
                if apply and after is not None and reason != "unparseable":
                    data[key] = after
                    changed = True
            if apply and changed:
                cur.execute(f"UPDATE {table} SET data_json=? WHERE rowid=?", (json.dumps(data, separators=(",", ":")), row["rowid"]))

    if apply:
        conn.commit()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize date values to YYYY-MM-DD.")
    parser.add_argument("--db", help="Path to SQLite database (defaults to NexIT data DB)")
    parser.add_argument("--apply", action="store_true", help="Apply changes (creates backup first)")
    parser.add_argument("--dry-run", action="store_true", help="Report only (default)")
    args = parser.parse_args()

    db_path = _db_path(args.db)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        return 1

    print(f"Database: {db_path}")
    if args.apply:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = db_path.with_suffix(db_path.suffix + f".{ts}.bak")
        shutil.copy2(db_path, backup)
        print(f"Backup created: {backup}")

    conn = sqlite3.connect(str(db_path))
    try:
        report = scan_and_apply(conn, apply=args.apply)
    finally:
        conn.close()

    print("\n=== Date Cleanup Counts (before/affected) ===")
    print(f'Rows/values with "not found"/"null": {report.notfound_null}')
    print(f"Rows/values with Excel serial numbers: {report.excel_serial}")
    print(f"Rows/values with sentinel 00-Jan-1900: {report.sentinel_00_jan_1900}")
    print(f"Other placeholder values normalized to blank: {report.placeholders_other}")
    print(f"Legacy parseable date values normalized to YYYY-MM-DD: {report.normalized_legacy}")
    print(f"Unparseable/non-standard values left unchanged (review): {report.unparseable}")
    mode = "APPLIED" if args.apply else "DRY-RUN (no changes made)"
    print(f"\nMode: {mode}")
    if report.details:
        print("\nDetails:")
        for line in report.details[:200]:
            print(" -", line)
        if len(report.details) > 200:
            print(f" ... and {len(report.details) - 200} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
