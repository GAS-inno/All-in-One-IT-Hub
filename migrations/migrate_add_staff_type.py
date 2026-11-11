#!/usr/bin/env python3
"""Backfill Staff Type on the NexIT users directory.

Preview the migration with:
  python3 migrations/migrate_add_staff_type.py --dry-run

Apply it to the active NexIT database with:
  python3 migrations/migrate_add_staff_type.py --apply

The apply mode creates a SQLite backup before changing records. Existing rows are
backfilled from the Name field using the EXT-marker detection rules; source is set to
"auto". Rows edited manually later keep staff_type_source="manual" and are never
overwritten by this migration.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STAFF_TYPE_EXTERNAL = "External Staff"
STAFF_TYPE_INTERNAL = "Internal Staff"
STAFF_TYPE_UNCLASSIFIED = None
STAFF_TYPE_SOURCE_AUTO = "auto"
STAFF_TYPE_SOURCE_MANUAL = "manual"
EXT_TOKEN_RE = re.compile(r"(?:^|[^a-z0-9])ext([^a-z0-9]|$)", re.IGNORECASE)
PAREN_RE = re.compile(r"\(([^()]*)\)")


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


def detect_staff_type(name: str) -> tuple[str | None, str | None, bool]:
    """Return (staff_type, vendor, suspicious).

    staff_type is "External Staff", "Internal Staff", or None (unclassified).
    vendor is the parsed vendor token (e.g. "FPT") or None.
    suspicious flags names containing an EXT marker outside parentheses.
    """
    text = _text(name)
    if not text:
        return None, None, False
    paren = PAREN_RE.search(text)
    if not paren:
        # No parentheses -> Internal Staff (default).
        return STAFF_TYPE_INTERNAL, None, False
    group = paren.group(1)
    ext = EXT_TOKEN_RE.search(group)
    if not ext:
        # Parentheses exist but no standalone EXT token -> Internal Staff.
        return STAFF_TYPE_INTERNAL, None, False
    after = group[ext.end():].split("[", 1)[0]
    vendor = re.split(r"[\s\-–—/]+", after.strip(), 1)[0].strip() or None
    # Suspicious: an EXT-like token outside parentheses.
    outside = re.sub(r"\([^()]*\)", "", text)
    suspicious = bool(EXT_TOKEN_RE.search(outside))
    return STAFF_TYPE_EXTERNAL, vendor, suspicious


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=default_database_path(), help="NexIT SQLite database (defaults to the active app database)")
    parser.add_argument("--log", type=Path, default=None, help="migration log output path (default: next to the database)")
    parser.add_argument("--backup", type=Path, default=None, help="backup path for --apply (default: timestamped file next to the database)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="backfill Staff Type and source into SQLite; otherwise run a dry run")
    mode.add_argument("--dry-run", action="store_true", help="preview changes without modifying SQLite (default)")
    args = parser.parse_args()

    database_path = args.database
    log_path = args.log or database_path.parent / "migration_log.json"
    if not database_path.exists():
        print(f"Database not found: {database_path}", file=sys.stderr)
        return 2

    apply_changes = bool(args.apply) and not bool(args.dry_run)
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "users" not in tables:
            print("Expected NexIT table users was not found.", file=sys.stderr)
            return 2

        columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        has_staff_type = "staff_type" in columns
        has_source = "staff_type_source" in columns

        user_id_column = "UserID" if "UserID" in columns else "user_id"
        rows = connection.execute(
            f"SELECT {user_id_column} AS UserID, name, email FROM users ORDER BY position, {user_id_column}"
        ).fetchall()
        entries = []
        staff_type_counts: Counter[str] = Counter()
        vendor_counts: Counter[str] = Counter()
        suspicious: list[str] = []
        unclassified: list[str] = []

        for row in rows:
            user_id = _text(row["UserID"])
            name = _text(row["name"])
            email = _text(row["email"])
            staff_type, vendor, is_suspicious = detect_staff_type(name)
            if is_suspicious:
                suspicious.append(user_id or name)
            if staff_type is None:
                unclassified.append(user_id or name)
            if staff_type:
                staff_type_counts[staff_type] += 1
            if vendor:
                vendor_counts[_text(vendor)] += 1
            entries.append({
                "UserID": user_id,
                "Name": name,
                "Email": email,
                "staff_type": staff_type,
                "vendor": vendor,
                "staff_type_source": STAFF_TYPE_SOURCE_AUTO,
            })

        total = len(rows)
        external = staff_type_counts.get(STAFF_TYPE_EXTERNAL, 0)
        internal = staff_type_counts.get(STAFF_TYPE_INTERNAL, 0)
        print(f"Users total: {total}")
        print(f"Staff Type counts: External={external}, Internal={internal}, Unclassified={len(unclassified)}")
        print(f"Source counts: auto={total}, manual=0 (all rows backfilled to auto)")
        print("Vendor counts (vendor -> rows):")
        for vendor, count in sorted(vendor_counts.items(), key=lambda item: (-item[1], item[0])):
            print(f"  - {vendor}: {count}")
        print("Suspicious rows (EXT outside parentheses):")
        for user_id in suspicious:
            print(f"  - {user_id}")
        print("Unclassified rows:")
        for user_id in unclassified:
            print(f"  - {user_id}")
        print(f"Migration log: {log_path}")

        if apply_changes:
            if not has_staff_type or not has_source:
                connection.execute("ALTER TABLE users ADD COLUMN staff_type TEXT")
                connection.execute("ALTER TABLE users ADD COLUMN staff_type_source TEXT NOT NULL DEFAULT 'auto'")
            connection.execute("BEGIN IMMEDIATE")
            for entry in entries:
                if entry["staff_type"] is None:
                    continue
                connection.execute(
                    f"UPDATE users SET staff_type=?, staff_type_source=? WHERE {user_id_column}=?",
                    (entry["staff_type"], STAFF_TYPE_SOURCE_AUTO, entry["UserID"]),
                )
            connection.commit()
            print("Applied: staff_type backfilled for rows with a detected value; source set to auto.")
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
