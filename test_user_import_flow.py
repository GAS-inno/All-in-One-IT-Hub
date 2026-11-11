#!/usr/bin/env python3
"""Simulate the User CSV import flow end-to-end against a temporary database."""

import pathlib
import tempfile

import server as s


def main() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        connection = s.connect_database(pathlib.Path(temp_dir) / "test.sqlite3")
        records = [
            {"UserID": "USR-1", "Name": "Alex User", "Email": "alex.ng@contoso.com", "Account Active": "YES", "Country": "Singapore", "Location": ""},
            {"UserID": "USR-2", "Name": "Sam User", "Email": "sam.user@contoso.com", "Account Active": "NO", "Country": "Malaysia", "Location": "Kuala Lumpur"},
        ]
        s._replace_users(connection, records)
        saved = s._read_users(connection)
        assert len(saved) == 2, saved
        assert saved[0]["Name"] == "Alex User"
        assert saved[0]["Email"] == "alex.ng@contoso.com"
        connection.close()
    print("User CSV import flow simulation passed: saved and read back 2 users.")


if __name__ == "__main__":
    main()
