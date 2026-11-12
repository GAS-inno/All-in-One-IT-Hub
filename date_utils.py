"""Shared date utilities for NexIT.

Standards:
- Internal storage: ISO 8601 YYYY-MM-DD (or None/blank where empty).
- UI display & CSV: DD-MMM-YYYY (e.g. 05-Dec-2021).
- Accepted inputs: DD-MMM-YYYY, YYYY-MM-DD, Excel serials (1899-12-30 epoch).
- Ambiguous numeric slash dates (e.g. 01/02/2024) are rejected.
- Placeholder/missing values ("not found", "null", empty/whitespace, etc.) are blank.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

DATE_DISPLAY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_DATE_MONTH_INDEX = {name.lower(): index + 1 for index, name in enumerate(DATE_DISPLAY_MONTHS)}
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


def parse_date_to_iso(value: Any, *, strict: bool = True) -> tuple[str, str]:
    """Parse/validate a date value to ISO YYYY-MM-DD.

    Returns (iso_or_empty, error_or_empty). Placeholder/missing values return blank.
    """
    raw = str(value or "").strip()
    if not raw or raw.casefold() in _PLACEHOLDER_VALUES:
        return "", ""

    display = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", raw)
    if display:
        day = int(display.group(1))
        month = _DATE_MONTH_INDEX.get(display.group(2).casefold())
        year = int(display.group(3))
        if month and _is_valid_calendar_date(year, month, day):
            return _iso(year, month, day), ""
        return "", f'Invalid date "{raw}". Use DD-MMM-YYYY (e.g. 05-Dec-2021).'

    iso_match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso_match:
        year = int(iso_match.group(1))
        month = int(iso_match.group(2))
        day = int(iso_match.group(3))
        if _is_valid_calendar_date(year, month, day):
            return _iso(year, month, day), ""
        return "", f'Invalid date "{raw}". Use YYYY-MM-DD or DD-MMM-YYYY.'

    slash = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", raw)
    if slash:
        first = int(slash.group(1))
        second = int(slash.group(2))
        year = int(slash.group(3))
        if first > 12 and second <= 12:
            day, month = first, second
        elif second > 12 and first <= 12:
            day, month = second, first
        elif strict:
            return "", f'Ambiguous date "{raw}". Use DD-MMM-YYYY or YYYY-MM-DD instead of guessing.'
        else:
            day, month = first, second
        if _is_valid_calendar_date(year, month, day):
            return _iso(year, month, day), ""
        return "", f'Invalid date "{raw}".'

    excel_iso = excel_serial_to_iso(raw)
    if excel_iso:
        return excel_iso, ""

    if strict:
        return "", f'Invalid date format "{raw}". Use DD-MMM-YYYY or YYYY-MM-DD.'
    return "", ""


def format_iso_to_display(value: Any) -> str:
    """Format an ISO/parseable date as DD-MMM-YYYY for UI/CSV display."""
    iso, _error = parse_date_to_iso(value, strict=False)
    if not iso:
        raw = str(value or "").strip()
        match = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", raw)
        if match:
            month = _DATE_MONTH_INDEX.get(match.group(2).casefold())
            if month:
                return f"{int(match.group(1)):02d}-{DATE_DISPLAY_MONTHS[month - 1]}-{int(match.group(3)):04d}"
        return ""
    year, month, day = iso.split("-")
    return f"{day}-{DATE_DISPLAY_MONTHS[int(month) - 1]}-{year}"


def normalize_date_field(record: dict[str, Any], *keys: str, strict: bool = True, canonical: str | None = None) -> str:
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
    iso, error = parse_date_to_iso(raw, strict=strict)
    if error:
        raise ValueError(f"{canonical_key}: {error}")
    record[canonical_key] = iso
    for key in keys[1:]:
        record.pop(key, None)
    return iso


def require_iso_date(value: Any, field_name: str) -> str:
    """Parse/validate a required or optional date field to ISO YYYY-MM-DD.

    Placeholder/missing values return empty string. Raises ValueError on invalid format.
    """
    iso, error = parse_date_to_iso(value, strict=True)
    if error:
        raise ValueError(f"{field_name}: {error}")
    return iso


def parse_iso_date(value: Any) -> date | None:
    iso, _error = parse_date_to_iso(value, strict=False)
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%d").date()
    except ValueError:
        return None


def today_iso() -> str:
    return date.today().strftime("%Y-%m-%d")
