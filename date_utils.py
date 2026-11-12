"""Shared date utilities for NexIT.

Standards:
- Storage, UI display, CSV import/export, and placeholders: YYYY-MM-DD (ISO 8601).
- Accepted inputs: YYYY-MM-DD strictly; Excel serials (1899-12-30 epoch) tolerated on import.
- Ambiguous numeric dates (e.g. 01/02/2024) are rejected with a clear error naming the required format.
- Placeholder/missing values ("not found", "null", empty/whitespace, sentinels) are blank/NULL.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

_PLACEHOLDER_VALUES = {
    "", "not found", "null", "none", "n/a", "na", "unknown", "-",
    "00-jan-1900", "0-jan-1900",
}
_EXCEL_EPOCH = datetime(1899, 12, 30)
_EXCEL_MAX_SERIAL = 2958465


def _is_valid_calendar_date(year: int, month: int, day: int) -> bool:
    try:
        datetime(year, month, day)
    except ValueError:
        return False
    return True


def _iso(year: int, month: int, day: int) -> str:
    return f"{year:04d}-{month:02d}-{day:02d}"


def is_placeholder_date(value: Any) -> bool:
    raw = str(value or "").strip()
    return raw.casefold() in _PLACEHOLDER_VALUES


def excel_serial_to_iso(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text or not re.fullmatch(r"\d+(?:\.0+)?", text):
        return None
    try:
        serial = float(text)
    except ValueError:
        return None
    if serial <= 0 or serial > _EXCEL_MAX_SERIAL:
        return None
    days = int(round(serial))
    try:
        parsed = _EXCEL_EPOCH.fromordinal(_EXCEL_EPOCH.toordinal() + days)
    except (OverflowError, ValueError):
        return None
    return parsed.strftime("%Y-%m-%d")


def parse_date_to_iso(value: Any, *, strict: bool = True, allow_excel: bool = True) -> tuple[str, str]:
    """Parse/validate a date value to ISO YYYY-MM-DD.

    Strict mode accepts YYYY-MM-DD only (plus Excel serials when allow_excel=True, e.g. import).
    Ambiguous numeric dates are rejected with a clear error naming the required format.
    Placeholder/missing/sentinel values return blank.
    """
    raw = str(value or "").strip()
    if not raw or raw.casefold() in _PLACEHOLDER_VALUES:
        return "", ""

    iso_match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso_match:
        year = int(iso_match.group(1))
        month = int(iso_match.group(2))
        day = int(iso_match.group(3))
        if _is_valid_calendar_date(year, month, day):
            return _iso(year, month, day), ""
        return "", f'Invalid date "{raw}". Use YYYY-MM-DD (e.g. 2025-12-05).'

    if allow_excel:
        excel_iso = excel_serial_to_iso(raw)
        if excel_iso:
            return excel_iso, ""

    if strict:
        # Detect common ambiguous/unsupported numeric formats to give a clear required-format error.
        if re.fullmatch(r"\d{1,2}[/-]\d{1,2}[/-]\d{4}", raw) or re.fullmatch(r"\d{1,2}-[A-Za-z]{3}-\d{4}", raw):
            return "", f'Invalid date format "{raw}". Required format: YYYY-MM-DD (e.g. 2025-12-05).'
        return "", f'Invalid date format "{raw}". Required format: YYYY-MM-DD (e.g. 2025-12-05).'
    return "", ""


def format_iso_to_display(value: Any) -> str:
    """Format a date value as YYYY-MM-DD for UI/CSV display."""
    iso, _error = parse_date_to_iso(value, strict=False, allow_excel=True)
    if iso:
        return iso
    # Fallback: already ISO-like
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    return ""


def normalize_date_field(record: dict[str, Any], *keys: str, strict: bool = True, allow_excel: bool = True, canonical: str | None = None) -> str:
    """Normalize the first present/non-empty date among keys to ISO and store back.

    Returns ISO string or empty string. Raises ValueError with a clear message on invalid input.
    """
    canonical_key = canonical or (keys[0] if keys else "")
    raw = ""
    for key in keys:
        if key in record and str(record.get(key) or "").strip() != "":
            raw = str(record.get(key) or "").strip()
            break
    if not raw:
        if any(key in record for key in keys):
            record[canonical_key] = ""
        for key in keys[1:]:
            record.pop(key, None)
        return ""
    iso, error = parse_date_to_iso(raw, strict=strict, allow_excel=allow_excel)
    if error:
        raise ValueError(f"{canonical_key}: {error}")
    record[canonical_key] = iso
    for key in keys[1:]:
        record.pop(key, None)
    return iso


def require_iso_date(value: Any, field_name: str, *, allow_excel: bool = True) -> str:
    """Parse/validate a required or optional date field to ISO YYYY-MM-DD.

    Placeholder/missing values return empty string. Raises ValueError on invalid format.
    """
    iso, error = parse_date_to_iso(value, strict=True, allow_excel=allow_excel)
    if error:
        raise ValueError(f"{field_name}: {error}")
    return iso


def parse_iso_date(value: Any) -> date | None:
    iso, _error = parse_date_to_iso(value, strict=False, allow_excel=True)
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%d").date()
    except ValueError:
        return None


def today_iso() -> str:
    return date.today().strftime("%Y-%m-%d")
