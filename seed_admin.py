#!/usr/bin/env python3
"""Create the initial NexIT admin login account.

Usage:
  python3 seed_admin.py --username admin --password 'StrongTempPassword123!'
  # or interactively:
  python3 seed_admin.py

If an auth user with the same username exists, the script exits without changes.
Passwords are hashed with PBKDF2-SHA256 before storage.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from server import connect_database, hash_password, _normalize_username, _utc_now_iso


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed initial NexIT admin account")
    parser.add_argument("--username", help="Admin username")
    parser.add_argument("--password", help="Admin password (prefer interactive prompt)")
    parser.add_argument("--force-reset-password", action="store_true", help="Reset password if the username already exists")
    args = parser.parse_args()

    username = _normalize_username(args.username or input("Admin username: "))
    if not username:
        print("Username is required.", file=sys.stderr)
        return 1
    password = args.password or getpass.getpass("Admin password (min 8 chars): ")
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 1

    now = _utc_now_iso()
    with connect_database() as connection:
        existing = connection.execute(
            "SELECT id, username, role FROM auth_users WHERE username=? COLLATE NOCASE",
            (username,),
        ).fetchone()
        if existing:
            if args.force_reset_password:
                connection.execute(
                    "UPDATE auth_users SET password_hash=?, updated_at=?, is_active=1 WHERE id=?",
                    (hash_password(password), now, existing["id"]),
                )
                connection.execute("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now, existing["id"]))
                connection.commit()
                print(f"Password reset for existing user '{existing['username']}'.")
                return 0
            print(f"User '{existing['username']}' already exists (role={existing['role']}). No changes made.")
            return 0

        connection.execute(
            """
            INSERT INTO auth_users(username, password_hash, role, is_active, must_change_password, failed_login_count, created_at, updated_at)
            VALUES (?, ?, 'admin', 1, 0, 0, ?, ?)
            """,
            (username, hash_password(password), now, now),
        )
        connection.commit()

    print(f"Admin account '{username}' created.")
    print("Sign in at the NexIT login screen. Change this password after first login if it was temporary.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
