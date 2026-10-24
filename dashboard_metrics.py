"""Dashboard field normalization and aggregate calculations."""

from __future__ import annotations

import re
from collections import Counter
from datetime import date, datetime
from typing import Any

FIELD_ALIASES = {
    "country": ("Intune_Group_APAC_Devices - Copy.Country", "Country"),
    "department": ("Intune_Group_APAC_Devices - Copy.Department", "Department"),
    "os": ("Windows Version", "OS", "OS version", "Operating System"),
    "status": ("check Active status", "DeviceStatus (active/inactive)", "Status"),
    "lifecycle": ("Lifecycle", "Remark", "Asset Lifecycle"),
    "warranty": ("Warranty Status", "Warranty Match Status"),
    "planned_action": ("Planned Action", "Action performed", "Action Status in intune"),
    "model": ("Model", "Intune_Group_APAC_Devices - Copy.Model", "IntuneGroup.Model"),
}
UNKNOWN = "Unknown"


def _text(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if value is not None:
            text = str(value).strip()
            if text and text.casefold() not in {"null", "none", "nan"}:
                return text
    return ""


def _first(record: dict[str, Any], field: str) -> str:
    return _text(record, *FIELD_ALIASES[field])


def _key(value: str) -> str:
    return " ".join(value.casefold().split())


def _serial_key(record: dict[str, Any]) -> str:
    serial = _text(record, "Serial number", "IntuneGroup.SerialNumber")
    while True:
        base, marker, suffix = serial.rpartition("--")
        if marker and suffix.isdigit():
            serial = base
        else:
            break
    return _key(serial) or _text(record, "Device ID") or _text(record, "Device name")


def _os(record: dict[str, Any]) -> str:
    for field in FIELD_ALIASES["os"]:
        value = _text(record, field)
        key = _key(value)
        if not value or key in {"0", "unknown", "n/a", "na", "err:509", "#value!"}:
            continue
        if "win11" in key or "windows 11" in key:
            return "Win11"
        if "win10" in key or "windows 10" in key:
            return "Win10"
        build = re.match(r"^10\.0\.(\d+)", key)
        if build:
            return "Win11" if int(build.group(1)) >= 22000 else "Win10"
        return value
    return UNKNOWN


def _lifecycle(record: dict[str, Any]) -> str:
    raw = _key(" ".join(_text(record, key) for key in (
        "Lifecycle", "Asset Lifecycle", "Remark", "Action performed", "Action Status in intune"
    )))
    if any(word in raw for word in ("decommission", "decommed", "dispose", "donate", "retired", "delete")):
        return "Decommissioned"
    if "stock" in raw or "spare" in raw:
        return "Stock"
    if any(word in raw for word in ("migration", "os upgrade", "win11 upgrade", "upgrade to win11")):
        return "Migration Required"
    if any(word in raw for word in ("refresh", "replace", "replacement")):
        return "Refresh/Replace"
    return "In Service"


def _status(record: dict[str, Any]) -> str:
    raw = _key(_first(record, "status"))
    lifecycle = _lifecycle(record)
    if lifecycle == "Stock":
        return "Stock"
    if lifecycle == "Decommissioned":
        return "Retired"
    if raw in {"active", "yes", "true", "1", "in service"}:
        return "Active"
    if raw in {"inactive", "no", "false", "0", "retired", "decommissioned"}:
        return "Retired" if raw in {"retired", "decommissioned"} else "Inactive"
    return "Inactive"


def _warranty_date(record: dict[str, Any]) -> date | None:
    value = _text(record, "Warranty End Date", "warrantyEndDate", "do not delete-warrantyEndDate_Dell", "Warranty Expiration Date")
    if not value:
        return None
    normalized = value.strip()
    patterns = (
        "%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y", "%m/%d/%Y %I:%M:%S %p",
        "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
        "%d/%m/%Y", "%d-%b-%Y", "%d-%m-%Y",
    )
    for pattern in patterns:
        try:
            parsed = datetime.strptime(normalized, pattern).date()
            return parsed if parsed.year >= 2000 else None
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00")).date()
        return parsed if parsed.year >= 2000 else None
    except ValueError:
        return None


def _warranty_status(record: dict[str, Any], today: date) -> str:
    explicit = _key(_first(record, "warranty"))
    if explicit and explicit not in {"unmatched", "unknown"}:
        if "expired" in explicit:
            return "Expired"
        if "expir" in explicit:
            return "Expiring within 90 Days"
        if "match" in explicit or "active" in explicit:
            end = _warranty_date(record)
            if end is None:
                return "Covered"
    end = _warranty_date(record)
    if end is None:
        return "Missing Warranty"
    if end < today:
        return "Expired"
    if (end - today).days <= 90:
        return "Expiring within 90 Days"
    return "Covered"


def _action(record: dict[str, Any]) -> str:
    return _text(record, "Planned Action", "Action performed", "Action Status in intune") or UNKNOWN


def _age_band(record: dict[str, Any]) -> str:
    age = _text(record, "Age", "Asset Age")
    match = re.search(r"(\d+)\s*Years?", age, re.IGNORECASE)
    if match:
        years = int(match.group(1))
    else:
        enrolled = _text(record, "Enrollment date", "Enrollment Date")
        try:
            start = datetime.fromisoformat(enrolled[:10]).date()
            years = max(0, (date.today() - start).days // 365)
        except ValueError:
            return UNKNOWN
    if years < 2:
        return "0-1 years"
    if years < 4:
        return "2-3 years"
    if years < 6:
        return "4-5 years"
    return "6+ years"


def _dimension_value(record: dict[str, Any], field: str, today: date) -> str:
    if field == "country":
        return _first(record, field) or UNKNOWN
    if field == "department":
        return _first(record, field) or UNKNOWN
    if field == "os":
        return _os(record)
    if field == "status":
        return _status(record)
    if field == "lifecycle":
        return _lifecycle(record)
    if field == "warranty":
        return _warranty_status(record, today)
    if field == "planned_action":
        return _action(record)
    if field == "model":
        return _first(record, field) or UNKNOWN
    if field == "age":
        return _age_band(record)
    return UNKNOWN


def filter_options(records: list[dict[str, Any]], today: date | None = None) -> dict[str, list[str]]:
    today = today or date.today()
    return {
        field: sorted({_dimension_value(row, field, today) for row in records}, key=str.casefold)
        for field in FIELD_ALIASES
    }


def _filtered_records(
    records: list[dict[str, Any]], filters: dict[str, str], today: date
) -> list[dict[str, Any]]:
    return [
        row for row in records
        if all(not value or _key(_dimension_value(row, field, today)) == _key(value) for field, value in filters.items())
    ]


def matching_record_indexes(
    records: list[dict[str, Any]],
    filters: dict[str, str],
    metric: str,
    today: date | None = None,
) -> list[int]:
    today = today or date.today()
    selected_pairs = [
        (index, row) for index, row in enumerate(records)
        if all(not value or _key(_dimension_value(row, field, today)) == _key(value) for field, value in filters.items())
    ]
    selected = [row for _, row in selected_pairs]

    if metric == "duplicateSerialNumbers":
        serial_counts = Counter(
            _serial_key(row) for row in selected
            if _text(row, "Serial number", "IntuneGroup.SerialNumber")
        )
        duplicate_keys = {key for key, count in serial_counts.items() if count > 1}
        duplicate_keys.update(
            _serial_key(row) for row in selected
            if row.get("Duplicate Serial") and _serial_key(row)
        )
        matches = [
            index for index, row in selected_pairs
            if _serial_key(row) in duplicate_keys and _serial_key(row)
        ]
    else:
        predicates = {
            "totalAssets": lambda row: True,
            "activeAssets": lambda row: _status(row) == "Active",
            "inactiveAssets": lambda row: _status(row) == "Inactive",
            "stock": lambda row: _status(row) == "Stock",
            "retired": lambda row: _status(row) == "Retired",
            "inService": lambda row: _lifecycle(row) == "In Service",
            "migrationRequired": lambda row: _lifecycle(row) == "Migration Required",
            "refreshReplace": lambda row: _lifecycle(row) == "Refresh/Replace",
            "decommissioned": lambda row: _lifecycle(row) == "Decommissioned",
            "expiredWarranty": lambda row: _warranty_status(row, today) == "Expired",
            "warrantyExpiring90Days": lambda row: _warranty_status(row, today) == "Expiring within 90 Days",
            "missingWarranty": lambda row: _warranty_status(row, today) == "Missing Warranty",
            "win10": lambda row: _os(row) == "Win10",
            "win11": lambda row: _os(row) == "Win11",
            "unknownOs": lambda row: _os(row) == UNKNOWN,
            "staleActiveDevices": lambda row: _status(row) == "Active" and _is_stale(row, today),
            "missingPrimaryUser": lambda row: not _text(
                row, "Primary user email address", "Primary user UPN",
                "Intune_Group_APAC_Devices - Copy.UserPrincipalName"
            ),
        }
        predicate = predicates.get(metric)
        if predicate is None:
            raise ValueError(f"Unknown dashboard metric: {metric}")
        matches = [index for index, row in selected_pairs if predicate(row)]
    return matches


def build_dashboard(records: list[dict[str, Any]], filters: dict[str, str] | None = None, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    filters = filters or {}
    selected = _filtered_records(records, filters, today)
    countries = sorted({_dimension_value(row, "country", today) for row in selected}, key=str.casefold)
    serial_counts = Counter(_serial_key(row) for row in selected if _text(row, "Serial number", "IntuneGroup.SerialNumber"))
    duplicate_serial_count = sum(count > 1 for count in serial_counts.values())
    flagged_duplicate_keys = {_serial_key(row) for row in selected if row.get("Duplicate Serial") and _serial_key(row)}
    duplicate_serial_count = max(duplicate_serial_count, len(flagged_duplicate_keys))
    kpis = {
        "totalAssets": len(selected),
        "activeAssets": sum(_status(row) == "Active" for row in selected),
        "inactiveAssets": sum(_status(row) == "Inactive" for row in selected),
        "stock": sum(_status(row) == "Stock" for row in selected),
        "retired": sum(_status(row) == "Retired" for row in selected),
        "inService": sum(_lifecycle(row) == "In Service" for row in selected),
        "migrationRequired": sum(_lifecycle(row) == "Migration Required" for row in selected),
        "refreshReplace": sum(_lifecycle(row) == "Refresh/Replace" for row in selected),
        "decommissioned": sum(_lifecycle(row) == "Decommissioned" for row in selected),
        "expiredWarranty": sum(_warranty_status(row, today) == "Expired" for row in selected),
        "warrantyExpiring90Days": sum(_warranty_status(row, today) == "Expiring within 90 Days" for row in selected),
        "missingWarranty": sum(_warranty_status(row, today) == "Missing Warranty" for row in selected),
        "win10": sum(_os(row) == "Win10" for row in selected),
        "win11": sum(_os(row) == "Win11" for row in selected),
        "unknownOs": sum(_os(row) == UNKNOWN for row in selected),
        "staleActiveDevices": sum(
            _status(row) == "Active" and _is_stale(row, today) for row in selected
        ),
        "missingPrimaryUser": sum(
            not _text(row, "Primary user email address", "Primary user UPN", "Intune_Group_APAC_Devices - Copy.UserPrincipalName")
            for row in selected
        ),
        "duplicateSerialNumbers": duplicate_serial_count,
    }
    status_series = ("Active", "Inactive", "Stock", "Retired")
    lifecycle_series = ("In Service", "Migration Required", "Refresh/Replace", "Decommissioned")
    warranty_series = ("Expired", "Expiring within 90 Days", "Covered", "Missing Warranty")

    def grouped(field: str, categories: tuple[str, ...]) -> list[dict[str, Any]]:
        return [{
            "label": category,
            "data": [sum(_dimension_value(row, field, today) == category and _dimension_value(row, "country", today) == country for row in selected) for country in countries],
        } for category in categories]

    def counts(field: str, categories: list[str] | tuple[str, ...]) -> dict[str, Any]:
        labels = list(categories)
        return {"labels": labels, "data": [sum(_dimension_value(row, field, today) == label for row in selected) for label in labels]}

    age_labels = ["0-1 years", "2-3 years", "4-5 years", "6+ years", UNKNOWN]
    os_labels = sorted({_os(row) for row in selected}, key=lambda x: (x == UNKNOWN, x.casefold()))
    warranty_labels = list(warranty_series)
    return {
        "refreshedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceRecordCount": len(selected),
        "distinctAssetCount": len({_serial_key(row) for row in selected}),
        "filters": filters,
        "kpis": kpis,
        "charts": {
            "statusByCountry": {"labels": countries, "datasets": grouped("status", status_series)},
            "lifecycleByCountry": {"labels": countries, "datasets": grouped("lifecycle", lifecycle_series)},
            "warrantyByCountry": {"labels": countries, "datasets": grouped("warranty", warranty_series)},
            "osDistribution": counts("os", os_labels),
            "refreshReplaceByCountry": {"labels": countries, "data": [sum(_lifecycle(row) == "Refresh/Replace" and _dimension_value(row, "country", today) == country for row in selected) for country in countries]},
            "ageBands": counts("age", age_labels),
        },
    }


def _is_stale(record: dict[str, Any], today: date) -> bool:
    value = _text(record, "LastSyncDateTime", "Last check-in", "Last Check-in")
    for pattern in ("%Y-%m-%d", "%m/%d/%Y", "%d %b %Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return (today - datetime.strptime(value[:19], pattern).date()).days > 90
        except ValueError:
            pass
    try:
        return (today - datetime.fromisoformat(value.replace("Z", "+00:00")[:25]).date()).days > 90
    except ValueError:
        return False
