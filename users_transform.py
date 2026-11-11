#!/usr/bin/env python3
"""Transform the user directory table into users_clean.csv.

Input columns (task spec): User | Email | Account Active | Country | Location | Assigned Assets | Actions
This tool normalizes headers (trim / case-insensitive) and maps known source columns.

Output columns: User ID | Name | Staff Type | Email | Account Active | Country | Location | Assigned Assets | Domain Check

Run (after code review / your OK):
    python3 users_transform.py
"""

import csv
import re
import unittest
from pathlib import Path

INPUT_PATH = Path("/tmp/opencode/users_dummy.csv")
OUTPUT_PATH = Path("/home/gasaw/SynologyDrive/Projects/AIO_IT/users_clean.csv")

CORPORATE_DOMAINS = {"ingenico.com"}
STAFF_EXTERNAL = "External Staff"
STAFF_INTERNAL = "Internal Staff"
STAFF_UNKNOWN = "Unknown"
PLACEHOLDER_EMAIL = "No User Assigned"
UNASSIGNED_NAME = "(unassigned)"

EXT_TOKEN_RE = re.compile(r"\bEXT\b", re.IGNORECASE)
EMAIL_TOKEN_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+")


def title_case(word: str) -> str:
    return word[:1].upper() + word[1:].lower() if word else word


def derive_name_from_email(email: str) -> str:
    """Derive a display name from the email local-part.

    Replaces '.' / '_' / digits with spaces, splits camelCase boundaries,
    then title-cases each word.
    """
    local = (email or "").split("@", 1)[0].strip()
    if not local:
        return ""
    camel_split = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", local)
    words = [w for w in re.split(r"[^A-Za-z]+", camel_split) if w]
    return " ".join(title_case(w) for w in words)


def derive_name_from_text(text: str) -> str:
    """Derive a display name from free text (used when no email exists)."""
    words = [w for w in re.split(r"[^A-Za-z0-9]+", text or "") if w]
    return " ".join(title_case(w) for w in words)


def split_name_email(cell: str):
    """Split a merged 'Name email' cell into (name, email)."""
    text = (cell or "").strip()
    if not text:
        return "", ""
    match = EMAIL_TOKEN_RE.search(text)
    if not match:
        return text, ""
    return text[: match.start()].strip(), match.group(0).strip()


def staff_type_for(name: str) -> str:
    """External Staff when the name contains the standalone token EXT; else Internal Staff."""
    if not (name or "").strip():
        return STAFF_UNKNOWN
    if EXT_TOKEN_RE.search(name):
        return STAFF_EXTERNAL
    return STAFF_INTERNAL


def domain_check_for(email: str) -> str:
    """Return 'OK' for corporate domains, 'Non-corporate' otherwise; '' when no email."""
    domain = (email or "").split("@", 1)[1].strip().lower() if "@" in (email or "") else ""
    if not domain:
        return ""
    return "OK" if domain in CORPORATE_DOMAINS else "Non-corporate"


def normalize_header(header: str) -> str:
    return (header or "").replace("﻿", "").strip().lower()


def transform_rows(rows):
    """Transform raw CSV row dicts into cleaned output rows sorted by User ID."""
    cleaned = []
    for row in rows:
        row = {normalize_header(k): (v if v is not None else "") for k, v in row.items()}
        email = (row.get("email") or "").strip()
        name_cell = (row.get("name") or "").strip()
        account_active = (row.get("account active") or "").strip()
        country = (row.get("country") or "").strip()
        location = (row.get("location") or "").strip()
        assigned_assets = (row.get("assigned assets") or "").strip()
        placeholder = name_cell.lower() == PLACEHOLDER_EMAIL.lower()

        name = ""
        email_out = ""
        if name_cell and EMAIL_TOKEN_RE.search(name_cell):
            name, email_out = split_name_email(name_cell)
        if not email_out and email:
            email_out = email
        if not name and not email_out and name_cell:
            name = derive_name_from_text(name_cell)
        if not name and email_out:
            name = derive_name_from_email(email_out)
        if placeholder:
            name = UNASSIGNED_NAME
        elif not name:
            name = ""

        if placeholder or not email_out:
            staff_type = STAFF_UNKNOWN
        else:
            staff_type = staff_type_for(name)

        cleaned.append({
            "User ID": "",
            "Name": name,
            "Staff Type": staff_type,
            "Email": email_out,
            "Account Active": account_active,
            "Country": country if country else "(blank)",
            "Location": location,
            "Assigned Assets": assigned_assets,
            "Domain Check": domain_check_for(email_out),
        })

    ordered = sorted(
        cleaned,
        key=lambda row: (
            1 if ((row["Email"] or "").strip().lower() == PLACEHOLDER_EMAIL.lower()) or (row["Name"] or "") == UNASSIGNED_NAME else 0,
            (row["Email"] or "").strip().lower(),
        ),
    )
    for index, row in enumerate(ordered, start=1):
        row["User ID"] = f"USR-{index:04d}"
    return ordered


def read_rows(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader]


def main() -> None:
    rows = read_rows(INPUT_PATH)
    cleaned = transform_rows(rows)
    with OUTPUT_PATH.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["User ID", "Name", "Staff Type", "Email", "Account Active", "Country", "Location", "Assigned Assets", "Domain Check"],
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(cleaned)
    staff_type_counts = {}
    country_counts = {}
    for row in cleaned:
        staff_type_counts[row["Staff Type"]] = staff_type_counts.get(row["Staff Type"], 0) + 1
        country_counts[row["Country"]] = country_counts.get(row["Country"], 0) + 1
    rows_without_name = [row for row in cleaned if not (row["Name"] or "").strip()]
    print(f"Transformed {len(cleaned)} rows -> {OUTPUT_PATH}")
    print(f"Total rows: {len(cleaned)}")
    print(f"Staff Type counts: {staff_type_counts}")
    print(f"Country counts: {country_counts}")
    print(f"Rows where Name could not be derived: {[row['User ID'] for row in rows_without_name]}")


class NameDerivationTests(unittest.TestCase):
    def test_title_case_from_email(self):
        self.assertEqual(derive_name_from_email("Abby.ROSS@ingenico.com"), "Abby Ross")

    def test_camel_case_split_from_email(self):
        self.assertEqual(derive_name_from_email("AnhDung.LE@ingenico.com"), "Anh Dung Le")

    def test_digit_removal_from_email(self):
        self.assertEqual(derive_name_from_email("ahmad.faisal2@ingenico.com"), "Ahmad Faisal")

    def test_split_merged_name_email(self):
        name, email = split_name_email("Nattapong S. nattapong.s@contoso.com")
        self.assertEqual(name, "Nattapong S.")
        self.assertEqual(email, "nattapong.s@contoso.com")

    def test_name_from_text_without_email(self):
        self.assertEqual(derive_name_from_text("Anna"), "Anna")


class StaffTypeTests(unittest.TestCase):
    def test_external_staff_with_ext(self):
        self.assertEqual(staff_type_for("John Smith EXT - abc"), STAFF_EXTERNAL)

    def test_internal_staff_without_ext(self):
        self.assertEqual(staff_type_for("John Smith"), STAFF_INTERNAL)

    def test_unknown_when_name_missing(self):
        self.assertEqual(staff_type_for(""), STAFF_UNKNOWN)


if __name__ == "__main__":
    main()
